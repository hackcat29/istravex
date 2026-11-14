// Offline replay: run each fixture through two indexers and score them
// against the fixture's expected_indexed records.
//   naive     — derives effects from the envelope (the three lint-rule mistakes)
//   reference — derives effects from ledger metadata
// Verdicts: correct | incorrect | dropped.
//   node kit/replay/replay.mjs
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MuxedAccount, xdr } from '@stellar/stellar-sdk';
import { RESULTS, readCorpus } from '../lib/fixture.mjs';

const json = (v) => JSON.parse(JSON.stringify(v));
const decode = (type, b64) => (xdr[type] ?? { LedgerEntryChanges: xdr.OperationMeta }[type]).fromXDR(b64, 'base64');
const innerTx = (envJson) => (envJson.tx_fee_bump ? envJson.tx_fee_bump.tx.inner_tx.tx.tx : envJson.tx.tx);
const assetString = (a) => {
  const v = a.credit_alphanum4 ?? a.credit_alphanum12;
  return v ? `${v.asset_code}:${v.issuer}` : 'native';
};

const indexers = {
  'CAP-0027': {
    naive({ envelope: env }, e) {
      const pay = innerTx(env).operations[e.op_index].body.payment;
      const m = MuxedAccount.fromAddress(pay.destination, '0');
      // Bug pattern: muxed ID coerced to a JS number on its way to storage.
      return { recipient: m.baseAccount().accountId(), recipient_muxed_id: String(Number(m.id())) };
    },
    reference({ envelope: env }, e) {
      const pay = innerTx(env).operations[e.op_index].body.payment;
      const m = MuxedAccount.fromAddress(pay.destination, '0');
      return { recipient: m.baseAccount().accountId(), recipient_muxed_id: m.id() };
    },
  },
  'CAP-0015': {
    naive({ envelope: env }) {
      // Bug pattern: fee read from the envelope — the bid, paid by the inner source.
      const t = env.tx_fee_bump.tx;
      return { fee_charged: String(t.fee), fee_paid_by: t.inner_tx.tx.tx.source_account };
    },
    reference({ fee_meta, result }) {
      // Payer: the account debited in fee meta. Amount: TransactionResult.feeCharged.
      // Fee meta alone over-counts Soroban fees: it records the full debit
      // before the post-apply refund (see feeMetaDebit in replay.json).
      const changes = fee_meta.changes;
      const before = changes.find((c) => c.state?.data?.account)?.state.data.account;
      const after = changes.find((c) => c.updated?.data?.account)?.updated.data.account;
      return {
        fee_charged: String(result.fee_charged),
        fee_paid_by: after.account_id,
        feeMetaDebit: String(BigInt(before.balance) - BigInt(after.balance)),
      };
    },
  },
  'CAP-0073': {
    naive({ envelope: env }) {
      // Bug pattern: trustlines only recognised from classic changeTrust ops.
      const ops = innerTx(env).operations.filter((o) => o.body.change_trust);
      return ops.length ? { trustline_created: true } : null;
    },
    reference({ meta }) {
      const body = meta.v4 ?? meta.v3 ?? meta.v2;
      const tl = body.operations.flatMap((o) => o.changes).find((c) => c.created?.data?.trustline)?.created.data.trustline;
      return tl && {
        trustline_created: true,
        account: tl.account_id,
        asset: assetString(tl.asset),
        limit: tl.limit,
        classic_change_trust_ops: 0,
      };
    },
  },
};

const rows = [];
for (const { manifest: m, blobs } of readCorpus()) {
  const impl = indexers[m.cap_ids[0]];
  if (!impl || !m.expected_indexed) continue;
  const decoded = Object.fromEntries(m.files.map((f) => [f.name, json(decode(f.xdr_type, blobs[f.name]))]));
  for (const name of ['naive', 'reference']) {
    const observed = impl[name](decoded, m.expected_decoded ?? {});
    const expected = m.expected_indexed;
    const diffs = observed ? Object.keys(expected).filter((k) => String(observed[k]) !== String(expected[k])) : [];
    const verdict = !observed ? 'dropped' : diffs.length ? 'incorrect' : 'correct';
    rows.push({ fixture: m.id, cap: m.cap_ids[0], ledger: m.source.ledger, network: m.network, indexer: name, verdict, expected, observed, diffs });
  }
}
writeFileSync(join(RESULTS, 'replay.json'), JSON.stringify({ rows }, null, 2) + '\n');
for (const r of rows) console.log(r.fixture.padEnd(36), r.indexer.padEnd(10), r.verdict.padEnd(10), r.diffs.join(','));
