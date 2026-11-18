---
title: "4. Muxed accounts (CAP-0027)"
sidebar_label: "Muxed accounts"
sidebar_position: 9
description: "An M… address is an account plus an ID. Keep both."
---

:::warning Draft, not reviewed

This page has not yet been reviewed by a stellar-core or platform engineer and is not ready to publish.

:::

A muxed address (`M…`) is an ed25519 account **plus** a 64-bit ID. Exchanges and custodians use the ID to tell their customers apart inside one Stellar account.

## The rules

- **Index balances on the underlying `G…` account.** The ledger has no muxed accounts. Balances live on the base account.
- **Keep the ID with the record**, exactly (see [64-bit integers](./wide-integers.md)). wallet-backend stores it as `to_muxed_id` TEXT.
- **Expect fee-bumps.** Muxed destinations often arrive wrapped in a fee-bump, as in `cap27-muxed-payment-pubnet-0001`, so the operation is at `feeBump.tx.innerTx.v1.tx.operations[i]`. Code that only handles `v1` envelopes skips them.
- **Round-trip the `M…` strkey through your SDK in tests.** All three SDKs pass on this fixture.

## Why it matters

The muxed ID is how an exchange knows which customer a deposit belongs to. A rounded ID credits nobody, or the wrong person. A dropped ID turns a deposit into an unattributed transfer that someone has to reconcile by hand.
