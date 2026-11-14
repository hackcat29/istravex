// Order-insensitive form of ledger metadata.
//
// stellar-core 30.0.0 emits the LedgerEntryChange entries inside one
// operation's (or one transaction's) changes in an order that can differ
// between two runs of the same binary on identical input; consensus data
// (headers, transaction sets, results) is byte-identical. Comparing two
// generations therefore sorts every LedgerEntryChange list by its XDR bytes
// first. See corpus/findings.json, ISTRAVEX-F-0007.
import { xdr } from '@stellar/stellar-sdk';

function sortChanges(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 1 && value.every((c) => c instanceof xdr.LedgerEntryChange)) {
      const keyed = value.map((c) => [Buffer.from(c.toXDR()), c]);
      keyed.sort((a, b) => Buffer.compare(a[0], b[0]));
      value.splice(0, value.length, ...keyed.map((k) => k[1]));
      return;
    }
    for (const v of value) sortChanges(v, seen);
    return;
  }
  for (const v of Object.values(value)) sortChanges(v, seen);
}

/** Canonical bytes of an XDR value of `type` given as raw bytes: change lists sorted. */
export function canonicalBytes(type, raw) {
  const value = xdr[type].fromXDR(raw);
  sortChanges(value);
  return Buffer.from(value.toXDR());
}

/** True when two encodings differ only in the order of LedgerEntryChange lists. */
export const sameUpToChangeOrder = (type, a, b) => Buffer.compare(canonicalBytes(type, a), canonicalBytes(type, b)) === 0;
