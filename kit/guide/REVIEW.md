# Reviewing the indexer hardening guide

The SCF RFP this guide was written for asks for a guide "ready to publish on developers.stellar.org" and gates publication on review by a stellar-core or platform engineer. That review has not happened yet. This file says what a reviewer is asked to check, so the review can be quick and specific.

**Status:** requested on 18 November 2026 in [stellar/stellar-docs#3166](https://github.com/stellar/stellar-docs/issues/3166) (`kit/guide/review.json`). Until a review is recorded there, the developers.stellar.org export (`node kit/guide/export.mjs`) opens every page with a "Draft, not reviewed" warning, and CI fails if any page claims a review.

## What to read

- The guide, as published for Istravex: https://docs.istravex.com/guide/overview (14 pages).
- The same pages exported for developers.stellar.org (Docusaurus Markdown, with the draft warning): [`kit/guide/stellar-docs/`](stellar-docs/).
- The field table's source: [`kit/guide/fields.json`](fields.json).

## Where judgment is needed

### 1. The field table: what stellar-core validates, and what it passes through

[What stellar-core validates](https://docs.istravex.com/guide/validated-fields) has 15 rows. For each, the guide states what stellar-core checks before a transaction is applied, and what it passes through untouched. CI checks every row's corpus evidence against the fixture manifests, but a manifest can only show what a ledger contains, not what core would have refused. So:

- **Backed by corpus fixtures that sit at the boundary** (the claim and real or generated ledger data agree, and a decoder test exercises the limit): bounded vectors and strings (100 operations, 20 signatures, 28-byte memo, and 101 / 29 refused), memo text bytes (a 28-byte memo that isn't UTF-8, accepted by the pinned stellar-core), muxed IDs (up to 2⁶⁴ − 1 on mainnet), signer keys (a signed-payload signer with a 32-byte payload, on testnet), liquidity pool asset order (a pool whose issuers sort differently as strkeys and as bytes), amounts (i64::MAX stroops), effects of contract calls (a trustline created by SAC `trust()`), ledger headers (Horizon's hash equals the SHA-256 of the header in every whole-ledger fixture).
- **Resting on stellar-core's behaviour as described, not tested by a probe here.** These are the rows to read first:
  - *Signatures:* "every signature verifies, the signers' weights meet each operation's threshold, at most 20, and none is unused".
  - *Sequence numbers:* "the source account's next sequence number, or within the transaction's sequence preconditions".
  - *Fees:* "the bid covers the minimum for every operation and the payer can pay it"; and that `FeeCharged` is set after apply, net of Soroban refunds.
  - *Time bounds:* "the ledger's close time falls inside them".
  - *Soroban authorization trees:* that shape (depth, width) is bounded only by the transaction size.
  - *Contract values:* host order (type, then value), no duplicate keys, the 100-level depth limit.
  - *Operations and participants:* "each operation is valid for its source when applied".

### 2. Recommended limits

[Recommended limits](https://docs.istravex.com/guide/limits) proposes depth and size caps for recursive values an indexer decodes (authorization trees, ScVal nesting) and cites the host's own limits for each. Are those the right numbers to recommend, and are the citations current at protocol 30?

### 3. Addresses and strkeys

[Addresses and strkeys](https://docs.istravex.com/guide/addresses) covers G, M, P and C addresses against SEP-0023, and says a participant is always the `G…` account, never its `M…` form. Is that the rule SDF wants indexers to follow?

### 4. The nine rules and the checklist

[The overview](https://docs.istravex.com/guide/overview) lists nine rules (take effects and participants from the meta, not the envelope; keep 64-bit integers exact; bound recursion; and so on), each with the corpus evidence and the upstream bugs behind it, and [a checklist](https://docs.istravex.com/guide/checklist). Is anything wrong, missing, or stated more strongly than stellar-core guarantees?

## Recording the review

A reviewer's comments go on the review request. When the guide is reviewed, `kit/guide/review.json` records who reviewed which version and when (`"status": "reviewed"`), the draft warnings come off, and the export can be proposed to developers.stellar.org.
