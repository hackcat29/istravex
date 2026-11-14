# Indexer hardening guide

**Status: reviewed and confirmed by a Stellar Core engineer (2026-11-14)**, the milestone 3 acceptance criterion. Every rule below cites a fixture in [`corpus/`](../corpus), a lint rule from [`istravex-lint`](../kit/go/lint), or a measured result in [`corpus/results/`](../corpus/results), so each one can be checked.

This guide is for anyone writing code that turns Stellar ledger data into records: indexers, explorers, wallets, analytics pipelines. It applies in any language. The Go lint rules automate the part of it that can be automated.

---

## 1. Read effects from ledger metadata, not the envelope

The envelope says what a transaction *asked* for. `LedgerCloseMeta` says what *happened*. When the two disagree, the metadata is right.

| Question | Wrong source | Right source | Evidence |
|---|---|---|---|
| Who paid the fee? | `Envelope.SourceAccount()` | Fee-bump fee account (`FeeBumpAccount`) / the account debited in fee changes | `cap15-fee-bump-pubnet-0001`, IX003 |
| How much was charged? | `Envelope.Fee()` (the bid) | `TransactionResult.FeeCharged` | `cap15-fee-bump-pubnet-0001`, IX003 |
| Was a trustline created? | Presence of a `changeTrust` op | A `CREATED` trustline entry in operation changes | `cap73-sac-trust-testnet-0001` |
| Which accounts were affected? | Envelope source + op destinations | Ledger entry changes and events in meta | replay harness |

**Measured:** the naive replay indexer, which reads effects from the envelope, gets all three indexed fixtures wrong: one dropped and two incorrect. The reference indexer, which reads metadata, gets all three right (`corpus/results/replay.json`). `stellar/wallet-backend` gets all four right (`corpus/results/pilot-wallet-backend.json`).

**Not every envelope read is wrong.** An operation with no source of its own runs as the *inner* transaction's source, fee-bump or not, so `Envelope.SourceAccount()` is the right fallback there. IX003 only fires inside fee logic for this reason. A broader version of the rule flagged two correct fallbacks in wallet-backend.

## 2. Fees on fee-bumps and Soroban

- The **payer** of a fee-bump is the outer fee source. In `cap15-fee-bump-pubnet-0001` that is `GA2J…HVAW`, not the inner source `GDMV…COIW`.
- The **charge** is `TransactionResult.FeeCharged`: 40,354 stroops in that fixture. The envelope bid was 46,341.
- **Fee changes alone over-count Soroban fees.** The fee-processing changes record a 46,340-stroop debit *before* the post-apply refund. The refund settles later in the transaction's meta. If you index fees from balance deltas, use the net of fee processing and post-apply fee processing, or simply read `FeeCharged`.

## 3. Keep 64-bit integers exact

Muxed IDs (`uint64`), amounts, balances and limits (`int64`), sequence numbers and operation IDs (TOIDs) all routinely exceed 2^53, the largest integer an IEEE-754 double holds exactly.

- `Number("1764988090084626463")` is `1764988090084626400` in JavaScript. That is a real mainnet muxed ID (`cap27-muxed-payment-pubnet-0001`).
- `i64::MAX` trustline limits (`cap73-sac-trust-testnet-0001`) and TOIDs like `281209887034449920` have the same problem.
- **Store** these as decimal strings or `NUMERIC`, never as floats. **Emit** them as JSON strings. `JSON.parse` in the consumer will round any bare number above 2^53. This corpus's own pilot driver hit exactly this bug before its adapter switched to string-encoded integers.
- In JS, use `BigInt` or the SDK's string accessors (`MuxedAccount.id()`).

## 4. Muxed accounts (CAP-0027)

- A muxed address is an ed25519 account **plus** a 64-bit ID. Keep both: index balances on the underlying `G…` account, and keep the ID with the record (wallet-backend stores it as `to_muxed_id` TEXT).
- Muxed destinations often arrive wrapped in a fee-bump (as in `cap27-muxed-payment-pubnet-0001`), so the operation path is `feeBump.tx.innerTx.v1.tx.operations[i]`.
- Round-trip the `M…` strkey through your SDK in tests. All three SDKs pass on this fixture (`corpus/results/{javascript,go,rust}.json`).

## 5. Signed-payload signers (CAP-0040)

- The signer key type `SIGNER_KEY_TYPE_ED25519_SIGNED_PAYLOAD` carries an ed25519 key **and** a payload of 1–64 bytes. Its strkey is a `P…` address.
- Store the full `P…` key, not only the ed25519 part. Two signers with the same key and different payloads are different signers. Fixture: `cap40-signed-payload-signer-testnet-0001`.

## 6. Trustlines without `changeTrust` (CAP-0073)

- Since protocol 26, the Stellar Asset Contract's `trust(address)` creates a trustline for a `G…` account through `invokeHostFunction`. There is no `changeTrust` op, and `trust` emits no event.
- The only record is the `CREATED` trustline entry in the operation's ledger changes, with limit `i64::MAX` (`9223372036854775807`). Indexers that recognise trustlines by operation type drop it. Fixture: `cap73-sac-trust-testnet-0001`.
- The same CAP lets native XLM transfers through the SAC create accounts. Watch account `CREATED` entries from contract invocations too.

## 7. Untrusted strings

- **Memo text is not validated as UTF-8 by stellar-core.** `MEMO_TEXT` is up to 28 arbitrary bytes. Horizon exposes `memo_bytes` for exactly this reason. Validate (`utf8.ValidString`) or store the raw bytes before writing to a `TEXT`/`JSON` column. Lint rule IX001. It found one latent instance in wallet-backend: a helper that nothing calls today.
- Treat any string you did not validate yourself as bytes.

## 8. Bound recursion

`ScVal` nests (vectors, maps, instances), and Soroban authorization trees nest (`SorobanAuthorizedInvocation.subInvocations`). Decoder limits (Go's `SafeUnmarshal` default depth, Rust `stellar-xdr`'s `Limits`) protect the decode step only, and only when they are left on. Your own walkers over decoded values must bound depth too: pass a depth counter and stop past a limit, rather than recursing until the stack runs out. Lint rule IX002.

## 9. Compare only consensus data

`TransactionMeta` can carry **diagnostic events**: node-local data that is not covered by consensus. The CAP-0073 fixture's meta from one RPC node's `getTransaction` and from another's `getLedgers` differed in one value only, a `core_metrics` `invoke_time_nsecs` event (188,866 vs 126,592 ns). The same is true of whole ledgers: re-fetching testnet ledgers 5727196 and 5727199 from the same RPC endpoint a few hours later returned `LedgerCloseMeta` with different sha256 hashes, because a different node behind the load balancer answered. The mainnet data-lake objects stayed byte-identical.

Do not index, hash or compare diagnostic events across nodes. Treat a captured ledger as a snapshot and pin it. The corpus does both: fixture meta comes from the stored canonical ledger (`kit/capture/canonicalize.mjs`, checked by `kit/go/cmd/verify`), and stored ledgers are not overwritten unless `--refresh` is passed.

---

## Checklist

Use this in code review, in any language.

- [ ] Effects, participants and balances are derived from ledger metadata, not the envelope.
- [ ] Fee payer comes from the fee-bump fee account; fee amount from `TransactionResult.FeeCharged`.
- [ ] Balance-delta fee accounting nets Soroban post-apply refunds.
- [ ] Every 64-bit integer is stored as a string or `NUMERIC`, and emitted as a JSON string.
- [ ] Muxed IDs are kept alongside the underlying account; fee-bump-wrapped operations are handled.
- [ ] Signed-payload signers are stored as full `P…` keys.
- [ ] Trustlines and accounts created by contract invocations (CAP-0073) are indexed from meta.
- [ ] Memo text is UTF-8 validated or stored as bytes.
- [ ] Recursive XDR walkers carry and check a depth limit.
- [ ] Diagnostic events are never used as indexed or compared data.
- [ ] The Istravex corpus replays through your pipeline (mock RPC: `npm run rpc`) with all fixtures correct.
- [ ] `istravex-lint ./...` is clean, or each finding is triaged.
