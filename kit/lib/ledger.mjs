// Read canonical LedgerCloseMeta (corpus/ledgers) and pull one transaction's
// consensus copies out of it. Fixture meta must come from here, not from
// getTransaction: TransactionMeta carries node-local diagnostic events (e.g.
// core_metrics invoke_time_nsecs) that differ between RPC nodes.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { xdr } from '@stellar/stellar-sdk';
import { CORPUS, FIXTURES, sha256 } from './fixture.mjs';

export function readLedger(network, seq) {
  const raw = zstdDecompressSync(readFileSync(join(CORPUS, 'ledgers', network, `${seq}.xdr.zst`)));
  return ledgerFromBatch(xdr.LedgerCloseMetaBatch.fromXDR(raw), seq);
}

export function ledgerFromBatch(batch, seq) {
  const lcm = batch.ledgerCloseMetas.find((m) => (m.v2 ?? m.v1 ?? m.v0).ledgerHeader.header.ledgerSeq === seq);
  if (!lcm) throw new Error(`ledger ${seq} not in batch`);
  return lcm;
}

/** Consensus copies of a transaction's result, meta and fee changes, as base64. */
export function txFromLedger(lcm, hashHex) {
  const body = lcm.v2 ?? lcm.v1 ?? lcm.v0;
  const tp = body.txProcessing.find((t) => t.result.transactionHash.toXDR('hex') === hashHex);
  if (!tp) throw new Error(`tx ${hashHex} not in ledger`);
  return {
    result: tp.result.result.toXDR('base64'),
    meta: tp.txApplyProcessing.toXDR('base64'),
    fee_meta: new xdr.OperationMeta({ changes: tp.feeProcessing }).toXDR('base64'),
  };
}

/** Replace one XDR file in a fixture and keep its manifest hashes in step. */
export function rewriteFixtureFile(id, name, b64) {
  const dir = join(FIXTURES, id);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const f = manifest.files.find((x) => x.name === name);
  if (!f) throw new Error(`${id} has no file ${name}`);
  writeFileSync(join(dir, f.path), b64 + '\n');
  f.sha256 = sha256(b64);
  f.bytes = Buffer.from(b64, 'base64').length;
  if (manifest.files[0] === f) manifest.sha256 = f.sha256;
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return f;
}

/**
 * Store a LedgerCloseMetaBatch (raw XDR) as corpus/ledgers/<network>/<seq>.xdr.zst
 * and index it. Pass `zst` to keep an upstream object byte-for-byte (data lake).
 */
export function storeLedger(network, seq, raw, source, zst = zstdCompressSync(raw)) {
  const dir = join(CORPUS, 'ledgers', network);
  mkdirSync(dir, { recursive: true });
  const path = `ledgers/${network}/${seq}.xdr.zst`;
  writeFileSync(join(CORPUS, path), zst);
  const indexPath = join(CORPUS, 'ledgers', 'index.json');
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : [];
  const entry = {
    network,
    ledger: seq,
    path,
    xdr_type: 'LedgerCloseMetaBatch',
    source,
    sha256: createHash('sha256').update(raw).digest('hex'),
    bytes: raw.length,
    compressed_bytes: zst.length,
  };
  const next = index.filter((e) => !(e.network === network && e.ledger === seq)).concat(entry);
  next.sort((a, b) => a.network.localeCompare(b.network) || a.ledger - b.ledger);
  writeFileSync(indexPath, JSON.stringify(next, null, 2) + '\n');
  return entry;
}

// SDF's public data lake. Testnet's prefix changes when testnet is reset.
const LAKES = {
  pubnet: 'https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/pubnet',
  testnet: 'https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/testnet/2025-12-18',
};

export function lakeUrl(network, seq) {
  const start = Math.floor(seq / 64000) * 64000;
  const rev = (n) => (0xffffffff - n).toString(16).toUpperCase().padStart(8, '0');
  return `${LAKES[network]}/${rev(start)}--${start}-${start + 63999}/${rev(seq)}--${seq}.xdr.zst`;
}

/** One ledger from the data lake: the stored object byte for byte, and its LedgerCloseMetaBatch. */
export async function fetchLakeLedger(network, seq) {
  const url = lakeUrl(network, seq);
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url);
    if (r.ok) {
      const zst = Buffer.from(await r.arrayBuffer());
      return { zst, raw: zstdDecompressSync(zst), source: url };
    }
    if (attempt === 4) throw new Error(`data lake ${r.status} for ${network}/${seq}`);
    await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
  }
}

export const ledgerStored = (network, seq) => existsSync(join(CORPUS, 'ledgers', network, `${seq}.xdr.zst`));
