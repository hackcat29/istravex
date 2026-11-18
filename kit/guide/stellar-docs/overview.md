---
title: "Indexer hardening guide"
sidebar_label: "Overview"
sidebar_position: 1
description: "What the network validates, what it passes through, and nine rules for turning Stellar ledger data into records correctly, each backed by evidence."
---

:::warning Draft, not reviewed

This page has not yet been reviewed by a stellar-core or platform engineer and is not ready to publish.

:::

:::warning

**Draft, not yet reviewed.** The RFP gates publication on review by a stellar-core or platform engineer, and that review hasn't happened. It has been requested publicly; [what a reviewer is asked to check](https://github.com/hackcat29/istravex/blob/main/kit/guide/REVIEW.md) lists the statements that rest on corpus evidence and the ones that rest on a source citation alone. The field table is checked against the corpus on every CI run either way.

:::

This guide is for anyone writing code that turns Stellar ledger data into records: indexers, explorers, wallets, custody systems, analytics pipelines. It applies in any language. Where a rule can be checked mechanically in Go, [istravex-lint](https://docs.istravex.com/tools/lint) does it.

Every rule cites something you can check yourself: a fixture in the corpus, a lint rule, or a measured result in `corpus/results/`. Nothing here is "best practice" by assertion.

## The one idea underneath all of it

> The envelope says what a transaction **asked** for. `LedgerCloseMeta` says what **happened**. When they disagree, the metadata is right.

Most of the rules are that idea applied to a specific field.

## Start here

- [What stellar-core validates](./validated-fields.md): Field by field: what the network checks, and what it passes through to you.
- [Recommended limits](./limits.md): Depth and size caps, each derived from a limit the network enforces.
- [Addresses and strkeys](./addresses.md): The SEP-0023 forms you'll meet, and three ways they're confused.

## The rules

- [1. Effects from metadata](./effects-from-meta.md): Participants, balances and created entries come from meta, not the envelope.
- [2. Fees](./fees.md): Who paid, how much, and why fee changes over-count Soroban fees.
- [3. 64-bit integers](./wide-integers.md): Muxed IDs, amounts, limits and TOIDs all exceed 2^53.
- [4. Muxed accounts](./muxed-accounts.md): Keep the account and the ID; expect fee-bump wrapping.
- [5. Signed-payload signers](./signed-payload-signers.md): Store the full P… key, payload included.
- [6. SAC trustlines](./sac-trustlines.md): Trustlines and accounts created without classic operations.
- [7. Untrusted strings](./untrusted-strings.md): Memo text isn't validated UTF-8.
- [8. Bounded recursion](./bounded-recursion.md): Walkers over ScVal and auth trees need a depth limit.
- [9. Consensus data only](./consensus-data.md): Diagnostic events differ between nodes. Never index them.

Short on time? Start with the [checklist](./checklist.md).

## Does following it work?

The replay harness measures it. An indexer that reads effects from the envelope gets **all nine** indexed cases wrong. One that follows these rules gets all nine right. [stellar/wallet-backend](https://docs.istravex.com/pilots/wallet-backend), which follows them today, gets all eleven fixtures it indexes right, over RPC and over the data lake. Its commits from before the September fixes get them wrong in exactly the ways rules 1, 4, 5 and 6 describe.

## Publishing

The guide is written to publish on developers.stellar.org. `npm run guide:export` turns these pages into plain Docusaurus Markdown (admonitions instead of Mintlify components, generated tables inlined, links made relative) in `build/guide/`; CI builds it on every commit.
