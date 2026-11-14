// Capture pinned mainnet transactions from Horizon into the corpus.
// Expected values come from Horizon's JSON, never from SDK decoding,
// so runners are checked against an independent source.
//   node kit/capture/mainnet.mjs
import { writeFixture } from '../lib/fixture.mjs';

const HORIZON = 'https://horizon.stellar.org';
const get = async (path) => {
  const r = await fetch(HORIZON + path);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
};

// Pinned hashes — re-running this script reproduces the same bytes.
const MUXED_TX = 'fff2333a20af37c71d0bbe8360dd0476a81e41d2be63eb114a0b7e8e68c21395';
const FEEBUMP_TX = 'ebfeab1b8fedae07fb94ade40d0dad8ebda6781dbfb3c182996f13aba33239fd';

async function capture(hash) {
  const tx = await get(`/transactions/${hash}`);
  const ledger = await get(`/ledgers/${tx.ledger}`);
  const ops = await get(`/transactions/${hash}/operations?limit=200`);
  return { tx, ledger, ops: ops._embedded.records };
}

const source = (tx) => ({
  kind: 'captured',
  network_endpoint: HORIZON,
  ledger: tx.ledger,
  tx_hash: tx.hash,
  closed_at: tx.created_at,
});

// ── CAP-0027: payment to a muxed account whose ID exceeds 2^53 ────────────
{
  const { tx, ledger, ops } = await capture(MUXED_TX);
  const pay = ops.find((o) => o.to_muxed_id);
  writeFixture({
    id: 'cap27-muxed-payment-pubnet-0001',
    cap_ids: ['CAP-0027'],
    protocol_version: ledger.protocol_version,
    network: 'pubnet',
    // Wallets often wrap payments in a fee-bump; record the real path.
    xdr_path: `${tx.fee_bump_transaction ? 'feeBump.tx.innerTx.v1' : 'v1'}.tx.operations[${ops.indexOf(pay)}].body.paymentOp.destination`,
    source: source(tx),
    expected_decoded: {
      tx_hash: tx.hash,
      fee_bumped: Boolean(tx.fee_bump_transaction),
      op_index: ops.indexOf(pay),
      destination_muxed: pay.to_muxed,
      destination_account: pay.to,
      muxed_id: pay.to_muxed_id,
      asset: pay.asset_type === 'native' ? 'native' : `${pay.asset_code}:${pay.asset_issuer}`,
      amount: pay.amount,
    },
    expected_indexed: { recipient: pay.to, recipient_muxed_id: pay.to_muxed_id },
    files: {
      envelope: { xdr_type: 'TransactionEnvelope', b64: tx.envelope_xdr },
      result: { xdr_type: 'TransactionResult', b64: tx.result_xdr },
    },
  });
}

// ── CAP-0015: fee-bump where the fee source differs from the inner source ─
{
  const { tx, ledger } = await capture(FEEBUMP_TX);
  writeFixture({
    id: 'cap15-fee-bump-pubnet-0001',
    cap_ids: ['CAP-0015'],
    protocol_version: ledger.protocol_version,
    network: 'pubnet',
    xdr_path: 'feeBump.tx.feeSource',
    source: source(tx),
    expected_decoded: {
      tx_hash: tx.hash,
      inner_tx_hash: tx.inner_transaction.hash,
      fee_source: tx.fee_account,
      inner_source: tx.source_account,
      max_fee: tx.max_fee,
    },
    expected_indexed: { fee_charged: tx.fee_charged, fee_paid_by: tx.fee_account },
    files: {
      envelope: { xdr_type: 'TransactionEnvelope', b64: tx.envelope_xdr },
      result: { xdr_type: 'TransactionResult', b64: tx.result_xdr },
      fee_meta: { xdr_type: 'LedgerEntryChanges', b64: tx.fee_meta_xdr },
    },
  });
}
