// Capture the canonical LedgerCloseMeta for every fixture's ledger.
//   pubnet  — SDF's public data lake (Galexie output on AWS Open Data), byte-for-byte
//   testnet — Stellar RPC getLedgers, wrapped in the same LedgerCloseMetaBatch format
// Stored as corpus/ledgers/<network>/<seq>.xdr.zst (zstd, data-lake layout).
//   node kit/capture/ledgers.mjs
import { zstdDecompressSync } from 'node:zlib';
import { xdr } from '@stellar/stellar-sdk';
import { readCorpus } from '../lib/fixture.mjs';
import { ledgerStored, storeLedger } from '../lib/ledger.mjs';

const LAKE = 'https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/pubnet';
const TESTNET_RPC = 'https://soroban-testnet.stellar.org';
const PER_PARTITION = 64000;
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
  return { raw, source: `${TESTNET_RPC}#getLedgers(${seq})` };
}

// Stored ledgers are pinned snapshots and are not overwritten unless --refresh
// is passed. RPC-served LedgerCloseMeta is not byte-stable: node-local
// diagnostic events differ between the RPC nodes behind one endpoint, so a
// re-fetch of the same testnet ledger can hash differently. Local (generated)
// ledgers are stored by kit/capture/generate.mjs and cannot be re-fetched.
const refresh = process.argv.includes('--refresh');
const seen = new Set();
for (const { manifest: m } of readCorpus()) {
  if (m.network === 'local' || m.network === 'synthetic') continue;
  // The primary transaction's ledger, and the ledgers of any related transactions.
  for (const seq of [m.source.ledger, ...(m.source.related ?? []).map((r) => r.ledger)]) {
    const key = `${m.network}/${seq}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!refresh && ledgerStored(m.network, seq)) {
      console.log(`${key}: pinned`);
      continue;
    }
    const got = m.network === 'pubnet' ? await pubnet(seq) : await testnet(seq);
    storeLedger(m.network, seq, got.raw, got.source, got.zst);
    console.log(`${key}: ${got.raw.length} B`);
  }
}
