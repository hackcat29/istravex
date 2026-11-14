// Re-source every fixture's TransactionMeta from the canonical ledger in
// corpus/ledgers, so fixture bytes equal what the network's ledger holds.
//   node kit/capture/canonicalize.mjs
import { readCorpus } from '../lib/fixture.mjs';
import { readLedger, rewriteFixtureFile, txFromLedger } from '../lib/ledger.mjs';

for (const { manifest: m, blobs } of readCorpus()) {
  const metaFile = m.files.find((f) => f.xdr_type === 'TransactionMeta');
  if (!metaFile) continue;
  const canonical = txFromLedger(readLedger(m.network, m.source.ledger), m.source.tx_hash).meta;
  if (canonical === blobs[metaFile.name]) {
    console.log(`${m.id}: already canonical`);
    continue;
  }
  const f = rewriteFixtureFile(m.id, metaFile.name, canonical);
  console.log(`${m.id}: ${metaFile.name} re-sourced from ledger ${m.source.ledger} (${f.sha256.slice(0, 12)})`);
}
