// Capture the canonical LedgerCloseMeta for every fixture's ledger.
//   pubnet  — SDF's public data lake (Galexie output on AWS Open Data), byte-for-byte
//   testnet — Stellar RPC getLedgers, wrapped in the same LedgerCloseMetaBatch format
// Stored as corpus/ledgers/<network>/<seq>.xdr.zst (zstd, data-lake layout).
//   node kit/capture/ledgers.mjs
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { xdr } from '@stellar/stellar-sdk';
import { ROOT, readCorpus } from '../lib/fixture.mjs';

const LAKE = 'https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/pubnet';
const TESTNET_RPC = 'https://soroban-testnet.stellar.org';
const PER_PARTITION = 64000;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const rev = (n) => (0xffffffff - n).toString(16).toUpperCase().padStart(8, '0');

export function lakeUrl(seq) {
  const start = Math.floor(seq / PER_PARTITION) * PER_PARTITION;
  return `${LAKE}/${rev(start)}--${start}-${start + PER_PARTITION - 1}/${rev(seq)}--${seq}.xdr.zst`;
}

async function pubnet(seq) {
  const url = lakeUrl(seq);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`data lake ${r.status} for ${seq}`);
  const zst = Buffer.from(await r.arrayBuffer());
  return { zst, raw: zstdDecompressSync(zst), source: url };
}

async function testnet(seq) {
  const r = await fetch(TESTNET_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLedgers', params: { startLedger: seq, pagination: { limit: 1 } } }),
  });
  const body = await r.json();
  const l = body.result?.ledgers?.[0];
  if (!l || l.sequence !== seq) throw new Error(`testnet RPC has no ledger ${seq} (retention window passed?)`);
  const lcm = xdr.LedgerCloseMeta.fromXDR(l.metadataXdr, 'base64');
  const batch = new xdr.LedgerCloseMetaBatch({ startSequence: seq, endSequence: seq, ledgerCloseMetas: [lcm] });
  const raw = Buffer.from(batch.toXDR());
  return { zst: zstdCompressSync(raw), raw, source: `${TESTNET_RPC}#getLedgers(${seq})` };
}

const index = [];
const seen = new Set();
for (const { manifest: m } of readCorpus()) {
  const key = `${m.network}/${m.source.ledger}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const got = m.network === 'pubnet' ? await pubnet(m.source.ledger) : await testnet(m.source.ledger);
  const dir = join(ROOT, 'corpus', 'ledgers', m.network);
  mkdirSync(dir, { recursive: true });
  const path = `ledgers/${m.network}/${m.source.ledger}.xdr.zst`;
  writeFileSync(join(ROOT, 'corpus', path), got.zst);
  index.push({
    network: m.network,
    ledger: m.source.ledger,
    path,
    xdr_type: 'LedgerCloseMetaBatch',
    source: got.source,
    sha256: sha(got.raw),
    bytes: got.raw.length,
    compressed_bytes: got.zst.length,
  });
  console.log(`${key}: ${got.raw.length} B (${got.zst.length} B zstd)`);
}
index.sort((a, b) => a.network.localeCompare(b.network) || a.ledger - b.ledger);
writeFileSync(join(ROOT, 'corpus', 'ledgers', 'index.json'), JSON.stringify(index, null, 2) + '\n');
