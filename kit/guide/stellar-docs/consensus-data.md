---
title: "9. Compare only consensus data"
sidebar_label: "Consensus data only"
sidebar_position: 14
description: "Some of what's in transaction metadata was never agreed by the network."
---

:::warning Draft, not reviewed

This page has not yet been reviewed by a stellar-core or platform engineer and is not ready to publish. Review requested in https://github.com/stellar/stellar-docs/issues/3166.

:::

`TransactionMeta` can carry **diagnostic events**: data written by whichever node executed the transaction, not covered by consensus. They're useful for debugging, and they're different on every node.

## What we measured

- The CAP-0073 fixture's meta from one RPC node's `getTransaction` and from another's `getLedgers` differed in exactly one value: a `core_metrics` `invoke_time_nsecs` event, 188,866 ns on one node and 126,592 ns on the other.
- Re-fetching testnet ledgers 5,727,196 and 5,727,199 from the same RPC endpoint a few hours later returned `LedgerCloseMeta` with different sha256 hashes, because a different node behind the load balancer answered.
- The mainnet data-lake objects stayed byte-identical across downloads.

## The rules

- Never index, hash or compare diagnostic events across nodes.
- If you hash or compare whole metadata (for deduplication, integrity checks or caching), strip diagnostic events first, or compare only the consensus parts.
- Treat a captured ledger as a snapshot, and pin it.

## How the corpus follows it

Fixture meta is cut from the stored canonical ledger (`kit/capture/canonicalize.mjs`, checked by the [provenance verifier](https://docs.istravex.com/corpus/provenance)), and stored testnet ledgers are never overwritten unless `--refresh` is passed. stellar-core's own goldens take the same approach and zero diagnostic events before they're written.
