# Corpus

Each fixture lives in `fixtures/<id>/`:

- `manifest.json`: provenance and expectations (schema below).
- `<name>.xdr.b64`: one base64 XDR value per file. `sha256` is over the decoded bytes.

| Field | Meaning |
|---|---|
| `id` | `<cap>-<pattern>-<network>-<n>` |
| `cap_ids` | CAPs that introduced or changed the pattern |
| `protocol_version` | Ledger protocol when captured |
| `network` | `pubnet`, `testnet` or `local` (a standalone network from `kit/capture/generate.mjs`) |
| `xdr_type`, `xdr_path`, `sha256` | Primary value (first entry of `files`) |
| `source` | `kind` (`captured` or `generated`), endpoint, ledger, tx hash, close time; generated sources add `generator` (stellar-core version, binary sha256, limits factor) |
| `synthetic` | `true` only for hand-authored entries (none yet) |
| `expected_decoded` | Field values every SDK must reproduce |
| `expected_indexed` | Records a correct indexer must store |
| `files` | Every XDR value in the fixture, with type, sha256 and size |

Expected values come from an independent source: Horizon JSON for mainnet captures, and the transaction as constructed for testnet and generated fixtures. They are never produced by the SDKs under test.

The schema is [`manifest.schema.json`](manifest.schema.json) (JSON Schema 2020-12). `kit/go/cmd/verify` checks every manifest against it.

## Canonical ledgers

`ledgers/<network>/<seq>.xdr.zst` holds the full `LedgerCloseMeta` (as a zstd `LedgerCloseMetaBatch`) for every fixture ledger, indexed in `ledgers/index.json`:

- **pubnet:** byte-for-byte objects from SDF's public data lake (`aws-public-blockchain/v1.1/stellar/ledgers/pubnet`)
- **testnet:** RPC `getLedgers`, stored once and pinned. A re-fetch can hash differently because node-local diagnostic events vary between RPC nodes.
- **local:** stellar-core's own `METADATA_OUTPUT_STREAM` during generation

`npm run corpus:verify` requires each fixture's XDR to be byte-identical to the ledger's copy.

## Fixtures

| Fixture | Where it came from |
|---|---|
| `cap27-muxed-payment-pubnet-0001` | Mainnet USDC payment to a muxed account whose ID is greater than 2^53, inside a fee-bump |
| `cap15-fee-bump-pubnet-0001` | Mainnet fee-bump where the fee source differs from the inner source, with fee meta |
| `cap40-signed-payload-signer-testnet-0001` | Testnet account with an ed25519 signed-payload signer, captured as the account `LedgerEntryData` |
| `cap73-sac-trust-testnet-0001` | Testnet trustline created by the Stellar Asset Contract `trust` function, with no `changeTrust` op |
| `cap40-signed-payload-signer-local-0001` | The same CAP-0040 scenario, generated on pinned stellar-core 30.0.0 |
| `cap73-sac-trust-local-0001` | The same CAP-0073 scenario, generated on pinned stellar-core 30.0.0 (Soroban limits raised 10x by settings upgrade) |

## Results

`results/<sdk>.json` comes from the SDK runners, `provenance.json` from the verifier, `replay.json` from the replay harness, and `pilot-wallet-backend.json` from the upstream pilot. `node kit/check-results.mjs` asserts they are all green.

## Re-capturing and generating

- `npm run corpus:capture` re-fetches the pinned mainnet transactions (same bytes every time) and creates *new* testnet cases, since testnet resets periodically.
- `npm run corpus:generate` builds the `local` fixtures on a fresh standalone network. It needs no external network and refuses any stellar-core binary other than the one pinned in `kit/capture/core-pin.json`.

Then run `npm run corpus:run`.
