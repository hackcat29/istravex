---
title: "What stellar-core validates"
sidebar_label: "Validated fields"
sidebar_position: 2
description: "Field by field, what the network checks before a transaction lands in a ledger, and what it passes through untouched."
---

:::warning Draft, not reviewed

This page has not yet been reviewed by a stellar-core or platform engineer and is not ready to publish.

:::

stellar-core is strict about some fields and indifferent to others. It checks every signature, every sequence number and every fee bid, because consensus depends on them. It doesn't check that memo text is UTF-8, it doesn't interpret a muxed account's ID, and it doesn't bound how deep a Soroban authorization tree goes, because nothing in consensus depends on those. An indexer that treats the second kind like the first is trusting data nobody vouched for.

This table is that distinction, field by field. Read the right-hand columns as a to-do list: everything in **What it passes through** is your code's responsibility.

| Field | stellar-core | What it checks | What it passes through | Corpus | Guide |
|---|---|---|---|---|---|
| **Signatures**<br />`TransactionEnvelope.signatures; AccountEntry.signers, thresholds` | ✓ validated | Every signature verifies, the signers' weights meet each operation's threshold, at most 20 signatures, and none is unused. | Nothing: but which signer signed is only a weight, not an identity the ledger records. | `max-length-vectors`, `tx` | — |
| **Sequence numbers**<br />`Transaction.seqNum` | ✓ validated | The source account's next sequence number, or within the transaction's sequence preconditions. | Nothing. | `fee-bump`, `muxed-payment` | — |
| **Fees**<br />`Transaction.fee, FeeBumpTransaction.fee, feeSource` | ✓ validated | The bid covers the minimum for every operation and the payer can pay it. | The bid is not the charge: FeeCharged is set after apply, net of Soroban refunds. On a fee-bump the payer is the fee source, not the envelope's source. | `fee-bump`, `muxed-payment`, `tx` | [fees](./fees.md) · IX003 |
| **Time bounds**<br />`Transaction.cond.timeBounds` | ✓ validated | The ledger's close time falls inside them. | Nothing; but a ledger's close time is the validators' agreed value, not wall-clock time. | `fee-bump`, `muxed-payment` | — |
| **Bounded vectors and strings**<br />`operations<100>, signatures<20>, signers<20>, memo text<28>` | ✓ validated | XDR decoding refuses one element or byte past each maximum. | Unbounded types (ScVec, ScMap, authorization subinvocations) have no XDR maximum: only the transaction size bounds them. | `max-length-vectors`, `over-max-length`, `scval-limits` | [limits](./limits.md) |
| **Memo text**<br />`Memo.text` | ✗ passed through | At most 28 bytes. | The bytes themselves: any 28 bytes are valid, UTF-8 or not. | `memo-non-utf8`, `tx` | [untrusted-strings](./untrusted-strings.md) · IX001 |
| **Muxed account IDs**<br />`MuxedAccount.med25519.id` | ✗ passed through | Nothing about the ID: the account behind it is checked as if unmuxed. | Any uint64, up to 2^64 − 1, never interpreted. The M… form is not an account: participants and balances belong to the G… account. | `muxed-payment`, `muxed-max-id`, `muxed-soroban-source` | [muxed-accounts](./muxed-accounts.md) · IX001, IX003 |
| **Soroban authorization trees**<br />`InvokeHostFunctionOp.auth[].rootInvocation.subInvocations` | ◐ partly | Each call that requires authorization must be authorized by a matching entry (signature, nonce, expiry). | The tree's shape: depth and width are bounded only by the transaction size (132,096 bytes on mainnet, November 2026). | `nested-auth` | [bounded-recursion](./bounded-recursion.md) · IX002 |
| **Contract values**<br />`ScVal, ScMap in arguments, contract data and events` | ◐ partly | Maps are sorted in host order (ScVal type first, then value) with no duplicate keys; the host refuses values deeper than 100 levels. | What the values are. Keys that differ as ScVals (u32 1, symbol "1") can print the same in your language. | `scmap-host-order`, `scval-limits` | [bounded-recursion](./bounded-recursion.md) · IX002 |
| **Signer keys**<br />`SignerKey (ed25519SignedPayload), AccountEntry.signers` | ◐ partly | The key type, and a payload of 1 to 64 bytes. | The payload's content. A signed-payload signer is a P… strkey of up to 101 bytes, not a 32-byte account key. | `signed-payload-signer` | [signed-payload-signers](./signed-payload-signers.md) |
| **Liquidity pool assets**<br />`LiquidityPoolConstantProductParameters (assetA, assetB, fee)` | ✓ validated | assetA sorts before assetB in network order (issuer key bytes, not strkey text), and the fee is 30 basis points. | Nothing; but strkey text order is not network order. | `pool-issuer-order` | [addresses](./addresses.md) |
| **Effects of contract calls**<br />`TransactionMeta.operations[].changes` | ✓ validated | The changes are the consensus result of applying the transaction. | The envelope doesn't say what a contract call did: a trustline created by trust() has no changeTrust operation. | `sac-trust` | [sac-trustlines](./sac-trustlines.md) |
| **Amounts**<br />`PaymentOp.amount and every Int64 amount, balance and limit` | ✓ validated | Positive, at most i64::MAX stroops (922,337,203,685.4775807 units), and covered by the sender's balance and the receiver's limit. | Nothing; but the range is the whole int64. A double holds stroops exactly only to 2^53 (900,719,925.4740992 units): above that, a float column stores a different amount. | `max-amount`, `muxed-payment` | [wide-integers](./wide-integers.md) |
| **Operations and participants**<br />`Transaction.operations, sourceAccount` | ✓ validated | Each operation is valid for its source when applied. | What the envelope names is what was asked for; the meta says what happened, to which accounts. | `muxed-payment`, `muxed-max-id`, `muxed-soroban-source`, `tx` | [effects-from-meta](./effects-from-meta.md) · IX003 |
| **Ledger headers**<br />`LedgerCloseMeta.ledgerHeader; LedgerHeader (ledgerSeq, previousLedgerHash, ledgerVersion, baseFee, baseReserve, maxTxSetSize, scpValue.closeTime)` | ✓ validated | Consensus agrees on the header; its hash chains to the previous ledger's. The values change only by network upgrades, recorded in upgradesProcessing. | Nothing a reader must re-validate, but the header's encoding changes with the protocol (StellarValueExt gained STELLAR_VALUE_SIGNED_MS in protocol 30), so a decoder pinned to an older XDR stops at the upgrade. | `ledger` | — |

## How the table stays honest

The table isn't prose that can drift. It's generated from [`kit/guide/fields.json`](https://github.com/hackcat29/istravex/blob/main/kit/guide/fields.json), and CI checks it against the corpus on every commit:

- every pattern a row names has a fixture in the corpus;
- every manifest field a row names is set by one of those fixtures, so each claim has a real value behind it;
- every `expected_decoded` and `expected_indexed` field in the corpus is named by some row, so a new fixture can't add a field nobody classified.

The **Corpus** column names the fixtures where you can see each field on real ledger data. [Fixtures](https://docs.istravex.com/corpus/fixtures) lists them all.

## Reading the three verdicts

- **✓ validated**: A transaction with a bad value never makes it into a ledger. You can rely on the value, but you may still be reading the wrong one: the fee bid is validated, and it still isn't the fee charged.
- **◐ partly**: Some property is enforced and another isn't. Authorization entries must authorize what they claim, but nothing limits how deep the tree goes.
- **✗ passed through**: Any value the XDR type allows will appear on the network eventually. Code for the whole range.

:::tip

Not yet reviewed by a stellar-core or platform engineer; see the [overview](./overview.md). CI checks the table against every fixture manifest.

:::
