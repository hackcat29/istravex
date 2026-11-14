// Read canonical LedgerCloseMeta (corpus/ledgers) and pull one transaction's
// consensus copies out of it. Fixture meta must come from here, not from
// getTransaction: TransactionMeta carries node-local diagnostic events (e.g.
// core_metrics invoke_time_nsecs) that differ between RPC nodes.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { xdr } from '@stellar/stellar-sdk';
import { FIXTURES, ROOT, sha256 } from './fixture.mjs';

export function readLedger(network, seq) {
  const raw = zstdDecompressSync(readFileSync(join(ROOT, 'corpus', 'ledgers', network, `${seq}.xdr.zst`)));
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
