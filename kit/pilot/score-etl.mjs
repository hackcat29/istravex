// Score stellar-etl's export rows for one fixture against its expected_indexed.
// Verdicts as everywhere: correct | incorrect (a row is there, a value is
// wrong or missing) | dropped (no row at all). Numbers are compared by their
// JSON source text (the driver parses with a source-keeping reviver), so a
// float amount that lost digits shows as exactly what stellar-etl wrote.

const check = (field, expected, observed) => ({ field, expected: String(expected), observed: observed === undefined ? '—' : String(observed), ok: String(expected) === String(observed) });
const payment = (out) => out.operations.find((o) => o.type_string === 'payment');
const stroops = (s) => {
  const [i, f = ''] = String(s).split('.');
  return (BigInt(i) * 10_000_000n + BigInt((f + '0000000').slice(0, 7))).toString();
};

const scorers = {
  'fee-bump'(e, out) {
    return { primary: out.transaction, checks: [check('fee_charged', e.fee_charged, out.transaction?.fee_charged), check('fee_account', e.fee_paid_by, out.transaction?.fee_account)] };
  },
  'muxed-payment'(e, out) {
    const p = payment(out);
    return { primary: p, checks: [check('to', e.recipient, p?.details.to), check('to_muxed_id', e.recipient_muxed_id, p?.details.to_muxed_id)] };
  },
  'muxed-max-id'(e, out) {
    const p = payment(out);
    const accounts = [out.transaction?.account, p?.details.to].filter(Boolean).sort().join(',');
    return {
      primary: p,
      checks: [check('to', e.recipient, p?.details.to), check('to_muxed_id', e.recipient_muxed_id, p?.details.to_muxed_id), check('accounts', e.participants.join(','), accounts)],
    };
  },
  'signed-payload-signer'(e, out) {
    const s = out.signers.find((x) => x.account_id === e.account && x.signer === e.signer_added && !x.deleted);
    return { primary: s, checks: [check('signer', e.signer_added, s?.signer), check('weight', e.weight, s?.weight)] };
  },
  'sac-trust'(e, out) {
    const [code, issuer] = e.asset.split(':');
    const tl = out.trustlines.find((t) => t.account_id === e.account && t.asset_code === code && t.asset_issuer === issuer);
    const created = out.effects.find((x) => x.type_string === 'trustline_created' && x.address === e.account);
    return {
      primary: tl,
      checks: [
        check('trustline row', `${e.account} ${e.asset}`, tl && `${tl.account_id} ${tl.asset_code}:${tl.asset_issuer}`),
        check('trust_line_limit', e.limit, tl?.trust_line_limit),
        check('trustline_created effect', e.account, created?.address),
      ],
    };
  },
  'muxed-soroban-source'(e, out) {
    return { primary: out.transaction, checks: [check('account', e.participants[0], out.transaction?.account)] };
  },
  'max-amount'(e, out) {
    const p = payment(out);
    const credited = out.effects.find((x) => x.type_string === 'account_credited' && x.address === e.recipient);
    const tl = out.trustlines.find((t) => t.account_id === e.recipient);
    const exact = (v) => (v === undefined ? undefined : stroops(v));
    return {
      primary: p,
      checks: [
        check('operation amount', e.amount_stroops, exact(p?.details.amount)),
        check('account_credited amount', e.amount_stroops, exact(credited?.details.amount)),
        check('trustline balance', e.amount_stroops, exact(tl?.balance)),
      ],
    };
  },
};

// Transaction fixtures chosen by set cover: the transaction row and the
// operation rows against Horizon's values for the same transaction. A
// transform that errors on the transaction counts against it too.
function scoreTx(e, out) {
  const t = out.transaction;
  const checks = [
    check('transaction_hash', e.tx_hash, t?.transaction_hash),
    check('successful', e.successful, t?.successful),
    check('account', e.source_account, t?.account),
    check('fee_charged', e.fee_charged, t?.fee_charged),
    // A fee-bump's own fee is new_max_fee; max_fee is the inner transaction's.
    check(e.fee_account ? 'new_max_fee' : 'max_fee', e.max_fee, e.fee_account ? t?.new_max_fee : t?.max_fee),
    check('operation_count', e.operation_count, t?.operation_count),
    check('operation_types', e.operation_types, out.operations.map((o) => o.type_string).join(',')),
    check('transform_errors', 'none', out.transform_errors?.length ? out.transform_errors.join(' | ') : 'none'),
  ];
  if (e.fee_account) checks.push(check('fee_account', e.fee_account, t?.fee_account));
  return { primary: t, checks };
}

export function scoreEtl(manifest, out) {
  const base = { fixture: manifest.id, pattern: manifest.pattern, network: manifest.network, ledger: manifest.source.ledger, tx_hash: manifest.source.tx_hash };
  if (!out?.found || !out.transaction) return { ...base, verdict: 'dropped', checks: [check('transaction exported', manifest.source.tx_hash, out?.error ?? 'not found')] };
  const { primary, checks } = manifest.pattern === 'tx' ? scoreTx(manifest.expected_decoded, out) : scorers[manifest.pattern](manifest.expected_indexed, out);
  const verdict = !primary ? 'dropped' : checks.every((c) => c.ok) ? 'correct' : 'incorrect';
  return { ...base, verdict, checks };
}
