// JavaScript conformance runner (@stellar/stellar-sdk).
// Checks per fixture: decode, byte-exact re-encode, and a high-level
// ("native") conversion compared against the fixture's expected values.
//   node kit/runners/js/run.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MuxedAccount, Networks, StrKey, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { ROOT, RESULTS, readCorpus } from '../../lib/fixture.mjs';

const version = JSON.parse(
  readFileSync(join(ROOT, 'node_modules/@stellar/stellar-sdk/package.json'), 'utf8'),
).version;
const passphrase = { pubnet: Networks.PUBLIC, testnet: Networks.TESTNET, local: Networks.STANDALONE };

// Native checks use the SDK's own high-level forms: its XDR-JSON output
// (JSON.stringify of a decoded value), StrKey, MuxedAccount and Transaction.
const json = (v) => JSON.parse(JSON.stringify(v));
const assetString = (a) => {
  if (a === 'native') return 'native';
  const v = a.credit_alphanum4 ?? a.credit_alphanum12;
  return `${v.asset_code}:${v.issuer}`;
};
const stroops = (s) => {
  const n = BigInt(s);
  return `${n / 10_000_000n}.${(n % 10_000_000n).toString().padStart(7, '0')}`;
};
const innerTx = (env) => {
  const j = json(env);
  return j.tx_fee_bump ? j.tx_fee_bump.tx.inner_tx.tx.tx : j.tx.tx;
};

/** Fixture-specific checks. Each returns [field, expected, observed][]. */
const native = {
  'CAP-0027'({ manifest: m, decoded }) {
    const e = m.expected_decoded;
    const pay = innerTx(decoded.envelope).operations[e.op_index].body.payment;
    const muxed = MuxedAccount.fromAddress(pay.destination, '0');
    return [
      ['destination_muxed', e.destination_muxed, pay.destination],
      ['muxed_id', e.muxed_id, muxed.id()],
      ['destination_account', e.destination_account, muxed.baseAccount().accountId()],
      ['asset', e.asset, assetString(pay.asset)],
      ['amount', e.amount, stroops(pay.amount)],
    ];
  },
  'CAP-0015'({ manifest: m, blobs }) {
    const e = m.expected_decoded;
    const tx = TransactionBuilder.fromXDR(blobs.envelope, passphrase[m.network]);
    const hex = (h) => Buffer.from(h).toString('hex');
    return [
      ['tx_hash', e.tx_hash, hex(tx.hash())],
      ['inner_tx_hash', e.inner_tx_hash, hex(tx.innerTransaction.hash())],
      ['fee_source', e.fee_source, tx.feeSource],
      ['inner_source', e.inner_source, tx.innerTransaction.source],
    ];
  },
  'CAP-0040'({ manifest: m, decoded }) {
    const e = m.expected_decoded;
    const signer = json(decoded.ledger_entry).account.signers[0];
    const raw = Buffer.from(StrKey.decodeSignedPayload(signer.key));
    const len = raw.readUInt32BE(32);
    return [
      ['signer_strkey', e.signer_strkey, signer.key],
      ['signer_ed25519', e.signer_ed25519, StrKey.encodeEd25519PublicKey(raw.subarray(0, 32))],
      ['payload_hex', e.payload_hex, raw.subarray(36, 36 + len).toString('hex')],
      ['weight', String(e.weight), String(signer.weight)],
    ];
  },
  'CAP-0073'({ manifest: m, decoded }) {
    const e = m.expected_indexed;
    const created = trustlinesCreated(json(decoded.meta));
    const tl = created[0];
    return [
      ['trustline_created', 'true', String(created.length === 1)],
      ['account', e.account, tl?.account_id ?? '—'],
      ['asset', e.asset, tl ? assetString(tl.asset) : '—'],
      ['limit', e.limit, tl?.limit ?? '—'],
    ];
  },
};

/** Trustlines created anywhere in a TransactionMeta (XDR-JSON form, v2–v4). */
export function trustlinesCreated(metaJson) {
  const body = metaJson.v4 ?? metaJson.v3 ?? metaJson.v2;
  return body.operations
    .flatMap((op) => op.changes)
    .filter((c) => c.created?.data?.trustline)
    .map((c) => c.created.data.trustline);
}

// LedgerEntryChanges is an XDR typedef (an array) with no JS class; its bytes
// are identical to OperationMeta (a struct with one LedgerEntryChanges field).
const codec = (type) => xdr[type] ?? { LedgerEntryChanges: xdr.OperationMeta }[type];

const results = readCorpus().map(({ manifest, blobs }) => {
  const checks = { decode: 'fail', reencode: 'fail', native: 'fail' };
  const detail = [];
  const decoded = {};
  try {
    for (const f of manifest.files) decoded[f.name] = codec(f.xdr_type).fromXDR(blobs[f.name], 'base64');
    checks.decode = 'pass';
    const bad = manifest.files.filter((f) => decoded[f.name].toXDR('base64') !== blobs[f.name]);
    checks.reencode = bad.length ? 'fail' : 'pass';
    if (bad.length) detail.push(`re-encode differs: ${bad.map((f) => f.name).join(', ')}`);
    const rows = native[manifest.cap_ids[0]]({ manifest, blobs, decoded });
    const diffs = rows.filter(([, a, b]) => a !== b);
    checks.native = diffs.length ? 'fail' : 'pass';
    for (const [k, a, b] of diffs) detail.push(`${k}: expected ${a}, got ${b}`);
  } catch (err) {
    detail.push(String(err.message ?? err));
  }
  return { fixture: manifest.id, checks, detail };
});

// Precision probe: what JavaScript's Number does to every wide integer in the corpus.
const probes = readCorpus()
  .flatMap(({ manifest }) => [manifest.expected_decoded?.muxed_id, manifest.expected_indexed?.limit])
  .filter(Boolean)
  .map((s) => ({ input: s, number: String(Number(s)), exact: String(Number(s)) === s }));

const out = { sdk: 'javascript', package: '@stellar/stellar-sdk', version, runtime: `node ${process.versions.node}`, results, probes };
writeFileSync(join(RESULTS, 'javascript.json'), JSON.stringify(out, null, 2) + '\n');
for (const r of results) console.log(r.fixture.padEnd(42), JSON.stringify(r.checks), r.detail.join('; '));
console.log(probes);
