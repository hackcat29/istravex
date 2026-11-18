---
title: "2. Fees on fee-bumps and Soroban"
sidebar_label: "Fees"
sidebar_position: 7
description: "Three different numbers look like \"the fee\". Only one is."
---

:::warning Draft, not reviewed

This page has not yet been reviewed by a stellar-core or platform engineer and is not ready to publish. Review requested in https://github.com/stellar/stellar-docs/issues/3166.

:::

The [fee-bump fixture](https://docs.istravex.com/corpus/fixtures#fee-bump-fee-source) is a fee-bump around a Soroban transaction, and it contains three plausible-looking fees:

| Where | Value | What it is |
|---|---|---|
| Envelope | 46,341 stroops | The **bid**: the most the fee source agreed to pay |
| Fee changes in meta | 46,340 stroops | The **debit before the refund** |
| `TransactionResult.FeeCharged` | **40,354 stroops** | What was **charged** |

## The rules

- **The payer** of a fee-bump is the outer fee source: `GA2J…HVAW` in the fixture, not the inner source `GDMV…COIW`. In Go, check `IsFeeBump()` and use `FeeBumpAccount()`.
- **The charge** is `TransactionResult.FeeCharged`.
- **Fee changes alone over-count Soroban fees.** The fee-processing changes record the full debit before Soroban's post-apply refund, which settles later in the transaction's meta. If you derive fees from balance deltas, net fee processing against post-apply fee processing, or simply read `FeeCharged`.

## Why it matters

Fee accounting feeds balances, tax reports and reconciliation. Charging the inner source means the wrong customer's balance moves. Using the bid or the pre-refund debit over-reports fees by about 15% on this transaction, and the error grows with Soroban resource fees.

[IX003](https://docs.istravex.com/tools/lint/ix003) flags the first two mistakes in Go code.
