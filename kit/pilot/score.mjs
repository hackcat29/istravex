// Score an indexer's output for one fixture against its expected_indexed.
// Verdicts: correct | incorrect (record present, a field wrong) | dropped
// (the record the ledger supports is missing).
//
// `out` is the adapter output (kit/pilot/wallet-backend/adapter.go); every
// 64-bit integer in it is a string, so nothing here touches JS number precision.

const check = (field, expected, observed) => ({ field, expected: String(expected), observed: observed === undefined ? '—' : String(observed), ok: String(expected) === String(observed) });

const scorers = {
  // Payment to a muxed account: recipient credited, with the full muxed ID.
  'CAP-0027'(e, out) {
    const credit = out.state_changes.find((s) => s.category === 'BALANCE' && s.reason === 'CREDIT' && s.account === e.recipient);
    return { primary: credit, checks: [check('recipient credited', e.recipient, credit?.account), check('to_muxed_id', e.recipient_muxed_id, credit?.to_muxed_id)] };
  },
  // Fee-bump: fee charged as in the result, debited from the fee-bump payer.
  'CAP-0015'(e, out) {
    const fee = out.state_changes.find((s) => s.category === 'BALANCE' && s.reason === 'DEBIT' && s.operation_id === '0');
    return {
      primary: fee,
      checks: [
        check('fee_charged', e.fee_charged, out.transaction?.fee_charged),
        check('fee debited from', e.fee_paid_by, fee?.account),
        check('fee debit amount', e.fee_charged, fee?.amount),
      ],
    };
  },
  // Signed-payload signer: signer recorded with its full P-strkey and weight.
  'CAP-0040'(e, out) {
    const s = out.state_changes.find((x) => x.category === 'SIGNER' && x.reason === 'ADD' && x.account === e.account);
    return { primary: s, checks: [check('signer', e.signer_added, s?.signer), check('weight', e.weight, s?.signer_weight_new)] };
  },
  // SAC trust(): trustline created for the account with an i64::MAX limit.
  'CAP-0073'(e, out) {
    const tl = out.trustline_changes.find((t) => t.account === e.account && t.asset === e.asset);
    const sc = out.state_changes.find((x) => x.category === 'TRUSTLINE' && x.account === e.account);
    return {
      primary: tl,
      checks: [
        check('trustline operation', 'ADD', tl?.operation),
        check('asset', e.asset, tl?.asset),
        check('limit', e.limit, tl?.limit),
        check('TRUSTLINE state change', 'ADD', sc?.reason),
      ],
    };
  },
};

export function score(manifest, out) {
  const cap = manifest.cap_ids[0];
  const base = { fixture: manifest.id, cap, network: manifest.network, ledger: manifest.source.ledger, tx_hash: manifest.source.tx_hash };
  if (!out?.found) return { ...base, verdict: 'dropped', checks: [check('transaction indexed', manifest.source.tx_hash, out?.error ?? 'not found')] };
  const { primary, checks } = scorers[cap](manifest.expected_indexed, out);
  const verdict = !primary ? 'dropped' : checks.every((c) => c.ok) ? 'correct' : 'incorrect';
  return { ...base, verdict, checks };
}
