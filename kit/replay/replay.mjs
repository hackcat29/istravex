// Offline replay: run each fixture through two indexers and score them
// against the fixture's expected_indexed records.
//   naive     — derives effects and participants from the envelope (the
//               mistakes the lint rules look for)
//   reference — derives them from ledger metadata
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

/** Accounts whose entries the transaction changed: participants, from meta. */
function accountsChanged(meta) {
  const body = meta.v4 ?? meta.v3 ?? meta.v2;
  const changes = [...(body.tx_changes_before ?? []), ...body.operations.flatMap((o) => o.changes), ...(body.tx_changes_after ?? [])];
  const ids = changes.map((c) => (c.created ?? c.updated ?? c.state ?? c.restored)?.data?.account?.account_id).filter(Boolean);
  return [...new Set(ids)].sort();
}

const indexers = {
  'muxed-payment': {
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
  'fee-bump': {
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
  'sac-trust': {
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
  'muxed-max-id': {
    naive({ envelope: env }) {
      // Bug patterns: the muxed ID through Number(), and participants taken
      // from the envelope's addresses as written (M-addresses, not accounts).
      const tx = innerTx(env);
      const dest = tx.operations[0].body.payment.destination;
      const m = MuxedAccount.fromAddress(dest, '0');
      return { recipient: m.baseAccount().accountId(), recipient_muxed_id: String(Number(m.id())), participants: [tx.source_account, dest].sort() };
    },
    reference({ envelope: env, meta }) {
      const m = MuxedAccount.fromAddress(innerTx(env).operations[0].body.payment.destination, '0');
      return { recipient: m.baseAccount().accountId(), recipient_muxed_id: m.id(), participants: accountsChanged(meta) };
    },
  },
  'muxed-soroban-source': {
    naive({ envelope: env }) {
      // Bug pattern (wallet-backend#716): the source as written, an M-address.
      return { participants: [innerTx(env).source_account] };
    },
    reference({ meta }) {
      return { participants: accountsChanged(meta) };
    },
  },
};

const rows = [];
for (const { manifest: m, blobs } of readCorpus()) {
  const impl = indexers[m.pattern];
  if (!impl || !m.expected_indexed) continue;
  const decoded = Object.fromEntries(m.files.map((f) => [f.name, json(decode(f.xdr_type, blobs[f.name]))]));
  for (const name of ['naive', 'reference']) {
    const observed = impl[name](decoded, m.expected_decoded ?? {});
    const expected = m.expected_indexed;
    const diffs = observed ? Object.keys(expected).filter((k) => String(observed[k]) !== String(expected[k])) : [];
    const verdict = !observed ? 'dropped' : diffs.length ? 'incorrect' : 'correct';
    rows.push({ fixture: m.id, pattern: m.pattern, cap: m.cap_ids[0] ?? 'base', ledger: m.source.ledger, network: m.network, indexer: name, verdict, expected, observed, diffs });
  }
}
writeFileSync(join(RESULTS, 'replay.json'), JSON.stringify({ rows }, null, 2) + '\n');
for (const r of rows) console.log(r.fixture.padEnd(36), r.indexer.padEnd(10), r.verdict.padEnd(10), r.diffs.join(','));
