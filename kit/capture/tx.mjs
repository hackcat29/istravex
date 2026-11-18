// Capture one named transaction as a tx-profile fixture: bytes from the
// canonical ledger (stored from the data lake if missing), expected values
// from Horizon. For transactions a finding needs as evidence, beyond what the
// set cover in kit/capture/shapes.mjs picks.
//
//   node kit/capture/tx.mjs <network> <tx hash> <fixture id> [CAP-xxxx ...]
import { writeFixture } from '../lib/fixture.mjs';
import { fetchLakeLedger, ledgerStored, readLedger, storeLedger, txFromLedger } from '../lib/ledger.mjs';

const HORIZON = { pubnet: 'https://horizon.stellar.org', testnet: 'https://horizon-testnet.stellar.org' };
const [network, hash, id, ...capIds] = process.argv.slice(2);
if (!HORIZON[network] || !/^[0-9a-f]{64}$/.test(hash ?? '') || !id) {
  console.error('usage: node kit/capture/tx.mjs <pubnet|testnet> <tx hash> <fixture id> [CAP-xxxx ...]');
  process.exit(2);
}
const get = async (path) => {
  const r = await fetch(HORIZON[network] + path);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
};
const tx = await get(`/transactions/${hash}`);
const ops = (await get(`/transactions/${hash}/operations?limit=200`))._embedded.records;
const ledger = await get(`/ledgers/${tx.ledger}`);
if (!ledgerStored(network, tx.ledger)) {
  const got = await fetchLakeLedger(network, tx.ledger);
  storeLedger(network, tx.ledger, got.raw, got.source, got.zst);
}
const canon = txFromLedger(readLedger(network, tx.ledger), hash);
writeFixture({
  id,
  pattern: 'tx',
  cap_ids: capIds,
  protocol_version: ledger.protocol_version,
  network,
  xdr_path: 'envelope',
  source: {
    kind: 'captured',
    network_endpoint: HORIZON[network],
    ledger: tx.ledger,
    tx_hash: tx.hash,
    closed_at: tx.created_at,
    description: 'Captured by name (kit/capture/tx.mjs) as evidence for a finding; bytes from the canonical ledger, expected values from Horizon.',
  },
  expected_decoded: {
    profile: 'tx',
    tx_hash: tx.hash,
    successful: tx.successful,
    source_account: tx.source_account,
    ...(tx.fee_bump_transaction && { fee_account: tx.fee_account }),
    fee_charged: String(tx.fee_charged),
    max_fee: String(tx.max_fee),
    operation_count: tx.operation_count,
    operation_types: ops.map((o) => o.type).join(','),
    memo_type: tx.memo_type,
    signature_count: tx.signatures.length,
  },
  files: {
    envelope: { xdr_type: 'TransactionEnvelope', b64: tx.envelope_xdr },
    result: { xdr_type: 'TransactionResult', b64: canon.result },
    meta: { xdr_type: 'TransactionMeta', b64: canon.meta },
    fee_meta: { xdr_type: 'LedgerEntryChanges', b64: canon.fee_meta },
  },
});
