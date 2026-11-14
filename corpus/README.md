# Corpus

Each fixture lives in `fixtures/<id>/`:

- `manifest.json`: provenance and expectations (schema below).
- `<name>.xdr.b64`: one base64 XDR value per file. `sha256` is over the decoded bytes.

| Field | Meaning |
|---|---|
| `id` | `<cap>-<pattern>-<network>-<n>` |
| `cap_ids` | CAPs that introduced or changed the pattern |
| `protocol_version` | Ledger protocol when captured |
| `network` | `pubnet` or `testnet` |
| `xdr_type`, `xdr_path`, `sha256` | Primary value (first entry of `files`) |
| `source` | `kind: captured`, endpoint, ledger, tx hash, close time |
| `synthetic` | `true` only for hand-authored entries (none yet) |
| `expected_decoded` | Field values every SDK must reproduce |
| `expected_indexed` | Records a correct indexer must store |
| `files` | Every XDR value in the fixture, with type, sha256 and size |

Expected values come from an independent source: Horizon JSON for mainnet captures, and the transaction as constructed for testnet captures. They are never produced by the SDKs under test.

## Fixtures

| Fixture | Where it came from |
|---|---|
| `cap27-muxed-payment-pubnet-0001` | Mainnet USDC payment to a muxed account whose ID is greater than 2^53, inside a fee-bump |
| `cap15-fee-bump-pubnet-0001` | Mainnet fee-bump where the fee source differs from the inner source, with fee meta |
| `cap40-signed-payload-signer-testnet-0001` | Testnet account with an ed25519 signed-payload signer, captured as the account `LedgerEntryData` |
| `cap73-sac-trust-testnet-0001` | Testnet trustline created by the Stellar Asset Contract `trust` function, with no `changeTrust` op |

## Results

`results/<sdk>.json` is written by `kit/runners/*`. `results/replay.json` is written by `kit/replay/replay.mjs`.

## Re-capturing

`npm run corpus:capture` re-fetches the pinned mainnet transactions (same bytes every time). It also creates *new* testnet cases, because testnet resets periodically. Then run `npm run corpus:run`.
