---
title: "Review checklist"
sidebar_label: "Checklist"
sidebar_position: 5
description: "The whole guide as a code-review checklist, in any language."
---

:::warning Draft, not reviewed

This page has not yet been reviewed by a stellar-core or platform engineer and is not ready to publish. Review requested in https://github.com/stellar/stellar-docs/issues/3166.

:::

Copy this into your pull request template, or walk through it before shipping an ingestion change.

- [ ] Every field marked "passed through" in [What stellar-core validates](./validated-fields.md) is validated by your code before it's stored.
- [ ] Effects, participants and balances are derived from ledger metadata, not the envelope; participants are `G…` accounts, never `M…` forms. → [Rule 1](./effects-from-meta.md)
- [ ] The fee payer comes from the fee-bump fee account; the fee amount from `TransactionResult.FeeCharged`. → [Rule 2](./fees.md)
- [ ] Balance-delta fee accounting nets Soroban post-apply refunds. → [Rule 2](./fees.md)
- [ ] Every 64-bit integer is stored as a string or `NUMERIC`, and emitted as a JSON string. → [Rule 3](./wide-integers.md)
- [ ] Muxed IDs are kept alongside the underlying account; fee-bump-wrapped operations are handled. → [Rule 4](./muxed-accounts.md)
- [ ] Signed-payload signers are stored as full `P…` keys. → [Rule 5](./signed-payload-signers.md)
- [ ] Trustlines and accounts created by contract invocations are indexed from meta. → [Rule 6](./sac-trustlines.md)
- [ ] Memo text is UTF-8 validated or stored as bytes. → [Rule 7](./untrusted-strings.md)
- [ ] XDR walkers, recursive or with a work list, cap depth (100) and node count; untrusted XDR is decoded with limits. → [Rule 8](./bounded-recursion.md), [Limits](./limits.md)
- [ ] Each address column holds one strkey type at its full length; keys are sorted by bytes, not text. → [Addresses](./addresses.md)
- [ ] Diagnostic events are never indexed, hashed or compared across nodes. → [Rule 9](./consensus-data.md)
- [ ] The Istravex corpus replays through your pipeline with every fixture correct. → [Replaying into your indexer](https://docs.istravex.com/pilots/your-indexer)
- [ ] `istravex-lint ./...` is clean, or every finding is triaged with a reason. → [istravex-lint](https://docs.istravex.com/tools/lint)
