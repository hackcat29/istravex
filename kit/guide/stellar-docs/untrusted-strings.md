---
title: "7. Untrusted strings"
sidebar_label: "Untrusted strings"
sidebar_position: 12
description: "stellar-core stores bytes. Whether they're text is your problem."
---

:::warning Draft, not reviewed

This page has not yet been reviewed by a stellar-core or platform engineer and is not ready to publish.

:::

**Memo text is not validated as UTF-8 by stellar-core.** `MEMO_TEXT` is up to 28 arbitrary bytes. Horizon exposes `memo_bytes` alongside `memo` for exactly this reason.

## The rules

- Validate (`utf8.ValidString` in Go) before writing memo text to a `TEXT` or `JSON` column, or store the raw bytes.
- Treat any string you didn't validate yourself as bytes. That includes asset codes, home domains and data entry values.

## What goes wrong

- PostgreSQL rejects the row with *invalid byte sequence for encoding "UTF8"*, and ingestion stops at that ledger until someone intervenes.
- A JSON encoder substitutes U+FFFD, so the memo a deposit is routed by no longer matches what the sender wrote.

[IX001](https://docs.istravex.com/tools/lint/ix001) flags memo text read without validation. In wallet-backend it found one latent instance, a helper that nothing calls today.
