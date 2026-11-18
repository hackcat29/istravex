// Score what Horizon stored for one fixture against its expected values.
// Verdicts as everywhere: correct | incorrect (a row is there, a value is
// wrong or missing) | dropped (the transaction isn't stored).
//
// Set-cover fixtures (pattern tx) are scored against Horizon's own API values
// for the same transaction, so this checks that a fresh backfill reproduces
// what the public Horizon serves. Hand-written fixtures are scored against
// their expected_indexed, the same expectations wallet-backend and stellar-etl
// are held to.

const check = (field, expected, observed) => ({ field, expected: String(expected), observed: observed === undefined || observed === null ? '—' : String(observed), ok: String(expected) === String(observed) });

// Horizon stores the operation type as XDR's OperationType number.
const OP_TYPES = [
  'create_account', 'payment', 'path_payment_strict_receive', 'manage_sell_offer', 'create_passive_sell_offer', 'set_options', 'change_trust',
  'allow_trust', 'account_merge', 'inflation', 'manage_data', 'bump_sequence', 'manage_buy_offer', 'path_payment_strict_send',
  'create_claimable_balance', 'claim_claimable_balance', 'begin_sponsoring_future_reserves', 'end_sponsoring_future_reserves',
  'revoke_sponsorship', 'clawback', 'clawback_claimable_balance', 'set_trust_line_flags', 'liquidity_pool_deposit',
  'liquidity_pool_withdraw', 'invoke_host_function', 'extend_footprint_ttl', 'restore_footprint',
];
const EFFECT = { account_credited: 2, signer_created: 10, trustline_created: 20 };
const stroops = (s) => {
  const [i, f = ''] = String(s).split('.');
  return (BigInt(i) * 10_000_000n + BigInt((f + '0000000').slice(0, 7))).toString();
};

function scoreTx(e, out) {
  const t = out.transaction;
  const checks = [
    check('transaction_hash', e.tx_hash, t.transaction_hash),
    check('successful', e.successful, t.successful),
    check('account', e.source_account, t.account),
    check('fee_charged', e.fee_charged, t.fee_charged),
    // A fee-bump's own fee is new_max_fee; max_fee is the inner transaction's.
    check(e.fee_account ? 'new_max_fee' : 'max_fee', e.max_fee, e.fee_account ? t.new_max_fee : t.max_fee),
    check('operation_count', e.operation_count, t.operation_count),
    check('operation_types', e.operation_types, out.operations.map((o) => OP_TYPES[o.type] ?? `type ${o.type}`).join(',')),
    check('memo_type', e.memo_type, t.memo_type),
    check('source is a participant', e.source_account, out.participants.includes(e.source_account) ? e.source_account : undefined),
  ];
  if (e.fee_account) checks.push(check('fee_account', e.fee_account, t.fee_account));
  return checks;
}

const payment = (out) => out.operations.find((o) => o.type === 1)?.details;

const scorers = {
  'fee-bump': (e, out) => [check('fee_charged', e.fee_charged, out.transaction.fee_charged), check('fee_account', e.fee_paid_by, out.transaction.fee_account)],
  'muxed-payment': (e, out) => [check('to', e.recipient, payment(out)?.to), check('to_muxed_id', e.recipient_muxed_id, payment(out)?.to_muxed_id)],
  'muxed-max-id': (e, out) => [
    check('to', e.recipient, payment(out)?.to),
    check('to_muxed_id', e.recipient_muxed_id, payment(out)?.to_muxed_id),
    check('participants', [...e.participants].sort().join(','), [...new Set(out.participants)].sort().join(',')),
  ],
  'max-amount': (e, out) => [check('to', e.recipient, payment(out)?.to), check('amount_stroops', e.amount_stroops, payment(out) && stroops(payment(out).amount))],
  'signed-payload-signer': (e, out) => {
    const s = out.effects.find((x) => x.type === EFFECT.signer_created && x.address === e.account);
    return [check('signer_created', e.signer_added, s?.details?.public_key), check('weight', e.weight, s?.details?.weight)];
  },
  'sac-trust': (e, out) => {
    const [code, issuer] = e.asset.split(':');
    const c = out.effects.find((x) => x.type === EFFECT.trustline_created && x.address === e.account);
    return [check('trustline_created effect', e.account, c?.address), check('asset', `${code}:${issuer}`, c && `${c.details.asset_code}:${c.details.asset_issuer}`)];
  },
  'muxed-soroban-source': (e, out) => [check('participants', [...e.participants].sort().join(','), [...new Set(out.participants)].sort().join(','))],
};

export function scoreHorizon(manifest, out) {
  const base = { fixture: manifest.id, pattern: manifest.pattern, network: manifest.network, ledger: manifest.source.ledger, tx_hash: manifest.source.tx_hash };
  if (!out?.found) return { ...base, verdict: 'dropped', checks: [check('transaction stored', manifest.source.tx_hash, out?.error ?? 'not found')] };
  const checks = manifest.pattern === 'tx' ? scoreTx(manifest.expected_decoded, out) : (scorers[manifest.pattern]?.(manifest.expected_indexed, out) ?? []);
  return { ...base, verdict: checks.every((c) => c.ok) ? 'correct' : 'incorrect', checks };
}
