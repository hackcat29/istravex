---
title: "8. Bound recursion"
sidebar_label: "Bounded recursion"
sidebar_position: 13
description: "Decoder limits protect decoding. Your walkers need their own."
---

:::warning Draft, not reviewed

This page has not yet been reviewed by a stellar-core or platform engineer and is not ready to publish. Review requested in https://github.com/stellar/stellar-docs/issues/3166.

:::

`ScVal` nests: vectors, maps, contract instances. Soroban authorization trees nest too, through `SorobanAuthorizedInvocation.subInvocations`.

Decoders bound that nesting: go-stellar-sdk's `SafeUnmarshal` applies a default depth limit, and Rust's `stellar-xdr` takes `Limits`. But those limits protect the **decode step only**, and only when they're left on.

## The rule

Every walker you write over decoded values carries a depth counter and a node budget, and stops past either, instead of recursing until the stack (or the heap) runs out:

```go
func walk(v xdr.ScVal, depth int, budget *int) error {
    if depth > 100 {
        return errTooDeep
    }
    if *budget--; *budget < 0 {
        return errTooLarge
    }
    // … recurse with depth+1
}
```

[Recommended limits](./limits.md) says where 100 and the budget come from: the host's own depth limit, and what fits in the largest valid transaction.

## What goes wrong

A value that's deeper than your walker expects, whether built in memory, decoded with limits off, or assembled from parts, overflows the stack. In an indexer that's a crash on one ledger, then a crash loop on restart.

Rewriting the recursion as a loop over an explicit stack doesn't remove the problem; it moves it to the heap. A tree that's wide rather than deep (stellar-core bounds neither, only the transaction size) still needs a cap on the number of nodes.

[IX002](https://docs.istravex.com/tools/lint/ix002) flags both shapes in Go: recursive functions over these types with no depth or size guard, and work lists that push `SubInvocations` with no bound. On wallet-backend it flags the unbounded recursion over authorization trees that existed until [9538b3c](https://github.com/stellar/wallet-backend/commit/9538b3caeaebfeb3d034146c0ce9643c3066cf8a), and nothing on main.
