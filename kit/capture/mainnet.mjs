// Capture pinned mainnet transactions from Horizon into the corpus.
// Expected values come from Horizon's JSON, never from SDK decoding,
// so runners are checked against an independent source.
//   node kit/capture/mainnet.mjs
import { Asset, Networks } from '@stellar/stellar-sdk';
import { writeFixture } from '../lib/fixture.mjs';

const HORIZON = 'https://horizon.stellar.org';
const get = async (path) => {
  const r = await fetch(HORIZON + path);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
};

// Pinned hashes — re-running this script reproduces the same bytes. The last
// four were found by kit/go/cmd/mainnet-scan (.github/workflows/mainnet-scan.yml)
// in 400,000 ledgers ending at 65,483,590.
const MUXED_TX = 'fff2333a20af37c71d0bbe8360dd0476a81e41d2be63eb114a0b7e8e68c21395';
const FEEBUMP_TX = 'ebfeab1b8fedae07fb94ade40d0dad8ebda6781dbfb3c182996f13aba33239fd';
const MUXED_2_63_TX = '1a5e418524e95dd36932533636d96763d28719763bada5a5c31198e1acc01aa7'; // muxed ID above 2^63
const SAC_TRUST_TX = 'f4075df2bd9deeadc1cae476e7e13dd9f835618ea66c760c2257c686b9b915d4'; // USDC trust() through the SAC
const NESTED_AUTH_TX = 'dd7e5546ab749d3a4b45d60af7c5703147aef53f222a0c208771ba15b65057d3'; // authorization tree 4 deep, 12 invocations
const HUNDRED_OPS_TX = '08cf453203a4ac52a3b2cf575f5cc0482d668a5aba5e717846c9bdde66aa4db4'; // 100 operations
const TWENTY_SIGS_TX = 'd8743dd3bae350bc597febfc36074730cda493025bab01650471de3ffec3b6e7'; // 20 signatures

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

const stroops = (s) => {
  const [i, f = ''] = String(s).split('.');
  return (BigInt(i) * 10_000_000n + BigInt((f + '0000000').slice(0, 7))).toString();
};

// ── CAP-0027: payments to muxed accounts whose IDs exceed 2^53 (and 2^63) ─
for (const [hash, id, sightings] of [
  [MUXED_TX, 'cap27-muxed-payment-pubnet-0001', undefined],
  [MUXED_2_63_TX, 'cap27-muxed-payment-pubnet-0002', undefined],
]) {
  const { tx, ledger, ops } = await capture(hash);
  const pay = ops.find((o) => o.to_muxed_id);
  writeFixture({
    id,
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
    sightings,
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

// Meta is re-sourced from the canonical ledger by kit/capture/canonicalize.mjs;
// a placeholder of the right type is written here (Horizon no longer serves it).
const PENDING_META = 'AAAAAAAAAAA='; // TransactionMeta v0 with no operations

// ── CAP-0073: a USDC trustline created by the SAC's trust() on mainnet ────
{
  const { tx, ledger, ops } = await capture(SAC_TRUST_TX);
  const effects = (await get(`/transactions/${SAC_TRUST_TX}/effects?limit=50`))._embedded.records;
  const created = effects.find((e) => e.type === 'trustline_created');
  const asset = new Asset(created.asset_code, created.asset_issuer);
  writeFixture({
    id: 'cap73-sac-trust-pubnet-0001',
    cap_ids: ['CAP-0073'],
    protocol_version: ledger.protocol_version,
    network: 'pubnet',
    xdr_path: 'operations[0].changes[*].created.data.trustLine',
    source: { ...source(tx), sac_contract: asset.contractId(Networks.PUBLIC) },
    expected_decoded: { tx_hash: tx.hash, function: ops[0].function === 'HostFunctionTypeHostFunctionTypeInvokeContract' ? 'trust' : ops[0].function, contract: asset.contractId(Networks.PUBLIC) },
    expected_indexed: {
      trustline_created: true,
      account: created.account,
      asset: `${created.asset_code}:${created.asset_issuer}`,
      limit: stroops(created.limit),
      classic_change_trust_ops: ops.filter((o) => o.type === 'change_trust').length,
    },
    sightings: ['stellar/wallet-backend#731', 'stellar/stellar-etl#460'],
    files: {
      meta: { xdr_type: 'TransactionMeta', b64: PENDING_META },
      envelope: { xdr_type: 'TransactionEnvelope', b64: tx.envelope_xdr },
    },
  });
}

// ── CAP-0046: an authorization tree four levels deep, from mainnet ────────
// Horizon doesn't expose authorization trees, so the depth and count are the
// scanner's (go-stellar-sdk), and all three runners must agree with them.
{
  const { tx, ledger } = await capture(NESTED_AUTH_TX);
  writeFixture({
    id: 'cap46-nested-auth-pubnet-0001',
    cap_ids: ['CAP-0046'],
    protocol_version: ledger.protocol_version,
    network: 'pubnet',
    xdr_path: 'tx.operations[0].body.invokeHostFunctionOp.auth[0].rootInvocation',
    source: { ...source(tx), expected_from: 'kit/go/cmd/mainnet-scan (go-stellar-sdk), confirmed by the JavaScript and Rust runners' },
    expected_decoded: { auth_depth: 4, auth_invocations: 12 },
    files: {
      envelope: { xdr_type: 'TransactionEnvelope', b64: tx.envelope_xdr },
      meta: { xdr_type: 'TransactionMeta', b64: PENDING_META },
    },
  });
}

// ── Base protocol: 100 operations, and 20 signatures, on mainnet ──────────
{
  const many = await capture(HUNDRED_OPS_TX);
  const signed = await capture(TWENTY_SIGS_TX);
  writeFixture({
    id: 'base-max-length-vectors-pubnet-0001',
    cap_ids: [],
    protocol_version: many.ledger.protocol_version,
    network: 'pubnet',
    xdr_path: 'envelope: tx.operations (100); envelope_signatures: signatures (20)',
    source: { ...source(many.tx), related: [{ ledger: signed.tx.ledger, tx_hash: signed.tx.hash, files: ['envelope_signatures'] }] },
    expected_decoded: { operation_count: many.tx.operation_count, signature_count: signed.tx.signatures.length },
    files: {
      envelope: { xdr_type: 'TransactionEnvelope', b64: many.tx.envelope_xdr },
      envelope_signatures: { xdr_type: 'TransactionEnvelope', b64: signed.tx.envelope_xdr },
    },
  });
}
