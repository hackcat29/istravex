---
title: "6. Trustlines without changeTrust (CAP-0073)"
sidebar_label: "SAC trustlines"
sidebar_position: 11
description: "Since protocol 26, contracts can create trustlines and accounts. No classic operation is involved."
---

:::warning Draft, not reviewed

This page has not yet been reviewed by a stellar-core or platform engineer and is not ready to publish. Review requested in https://github.com/stellar/stellar-docs/issues/3166.

:::

Since protocol 26, the Stellar Asset Contract's `trust(address)` function creates a trustline for a `G…` account through `invokeHostFunction`. There is no `changeTrust` operation, and `trust` emits no event.

## The rule

Index trustlines from ledger entry changes, not from operation types. The only record of a SAC-created trustline is the `CREATED` trustline entry in the operation's changes, with a limit of `i64::MAX` (`9223372036854775807`).

The same CAP lets native XLM transfers through the SAC create accounts. Watch for account `CREATED` entries from contract invocations too.

## What goes wrong

An indexer that recognises trustlines by operation type never sees it. The [naive replay indexer](https://docs.istravex.com/tools/replay) **drops** both SAC trustline fixtures. A dropped record is the worst failure mode: nothing downstream knows anything is missing, and the holder's balance in that asset appears from nowhere later.

Note the limit, too: `i64::MAX` is above 2^53, so it's [another integer to keep exact](./wide-integers.md).

Fixtures: `cap73-sac-trust-testnet-0001` and `…-local-0001`.
