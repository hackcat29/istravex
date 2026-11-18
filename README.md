# Istravex

The XDR conformance and replay kit for Stellar, proposed for SCF #46 RFP 2. This repository holds the kit, the corpus, the API, the project site and its docs.

**Docs:** [docs.istravex.com](https://docs.istravex.com) · **Site:** [istravex.com](https://istravex.com) · **API:** [api.istravex.com](https://api.istravex.com/v1/stats) · **RPC:** `https://rpc.istravex.com/{pubnet,testnet,local}`

[![CI](https://github.com/hackcat29/istravex/actions/workflows/ci.yml/badge.svg)](https://github.com/hackcat29/istravex/actions/workflows/ci.yml)

## Results

| | |
|---|---|
| Corpus | 137 fixtures: 95 from mainnet, 30 from testnet, 10 generated on a pinned stellar-core (byte-reproducible, any passphrase), 2 synthetic ([corpus/](corpus/)). Chosen by set cover over a scan of 400,311 mainnet and testnet ledgers (59.6 million transactions) so that every XDR cell real traffic uses is in the corpus |
| Cell coverage | 470 of the 603 XDR cells a ledger reader can meet (union arms, flag bits, contract cost types) occur on the networks; the corpus covers all 470 ([cells](corpus/cells.json)) |
| CAP coverage | 45 of the 47 live CAPs that leave a shape in ledger data, the other 23 with the reason they leave none; open: CAP-0070 and CAP-0083 ([coverage](https://docs.istravex.com/corpus/cap-coverage)) |
| Provenance | 1,794/1,794 checks. Every non-synthetic fixture is byte-identical to the canonical `LedgerCloseMeta` of its ledger, stored from SDF's public data lake |
| SDK conformance | 2,810/2,816 checks across seven SDKs: `@stellar/stellar-sdk` 17.4.0, `go-stellar-sdk` 0.9.0, `stellar-xdr` 30.0.0 (Rust), Python `stellar-sdk` 17.0.1 and `stellar-xdr` 0.2.1, `java-stellar-sdk` 6.0.0, `stellar-php-sdk` 1.18.0. Every failure is a finding; js-stellar-sdk 17.2.0 and 17.2.1 fail exactly the checks for #1766, #1785 and #1789 |
| Upstream pilots | `stellar/wallet-backend` @ `3e22515`: 123/123 fixtures indexed correctly, over RPC and over the data lake; #729, #731 and #716 reproduce on the commits before their fixes. `stellar/stellar-etl` v2.8.34: 119/123, the rest its open issues #454 and #460 |
| Findings | 24 in [`corpus/findings.json`](corpus/findings.json): 7 new defects found by the kit (3 filed upstream, 4 drafted), 13 known bugs reproduced, 4 notes ([report](https://docs.istravex.com/project/findings)) |
| RFP sightings | 13 of the RFP's 18 reproduced in CI before and after their fixes, 3 exercised, 2 not covered with the reason ([sightings](https://docs.istravex.com/corpus/sightings)) |
| stellar-core goldens | 15,306/15,306 `LedgerCloseMeta` frames from core's `--check-lcm` data round-trip in JavaScript, Go and Rust |
| Guide | [Indexer hardening guide](https://docs.istravex.com/guide/overview); [field-by-field table](https://docs.istravex.com/guide/validated-fields) checked against the corpus |

## Kit

| Path | What |
|---|---|
| `corpus/` | Fixtures (`manifest.json` + base64 XDR), the canonical ledgers they came from, the JSON Schema, the CAP audit, and results |
| `kit/capture/` | `mainnet.mjs` (Horizon + data lake), `testnet.mjs` (RPC), `generate.mjs` (pinned standalone stellar-core); the drivers share `scenarios.mjs` |
| `kit/go/cmd/verify` | Provenance: schema, sha256, protocol version, and byte equality against the canonical ledger |
| `kit/runners/{js,rust,python,python-xdr,java,php}`, `kit/go/cmd/conformance` | SDK runners for JavaScript, Go, Rust, Python (`stellar-sdk` and `stellar-xdr`), Java and PHP: decode, byte-exact re-encode, named native checks; a JavaScript release matrix |
| `kit/go/cmd/shape-scan`, `.github/workflows/shape-scan.yml` | Record which XDR cells every transaction and ledger exercises, from SDF's public data lake (pubnet and testnet) |
| `kit/capture/shapes.mjs`, `kit/capture/tx.mjs` | Choose fixtures by set cover over the scans until every cell seen on the networks is covered; capture a named transaction |
| `kit/audit/cell-caps.mjs`, `kit/audit/caps.mjs` | Which CAP introduced each cell; CAP and cell coverage (`corpus/coverage.json`, `corpus/cells.json`) |
| `kit/*/sweep`, `.github/workflows/sweep.yml` | Every SDK over whole ledgers of real traffic: byte-exact round-trip, and every transaction hash against the one stellar-core recorded |
| `kit/sightings/`, `corpus/sightings.json` | The RFP's 18 sightings: reproductions before and after each fix, and how each is covered |
| `kit/go/cmd/mainnet-scan`, `.github/workflows/mainnet-scan.yml` | Search mainnet history (SDF's public data lake) for every corpus pattern |
| `kit/capture/` | Capture (mainnet, testnet) and the reproducible generator on a pinned stellar-core, its probe contract, and the synthetic fixtures |
| `kit/rpc/` | Mock Stellar RPC (`getHealth`, `getNetwork`, `getLatestLedger`, `getLedgers`) serving the corpus offline, with bounded memory |
| `kit/datalake/` | The corpus in the Galexie data-lake layout, plus a read-only S3 endpoint over it |
| `kit/replay/` | Naive and reference indexers scored against `expected_indexed` |
| `kit/pilot/` | stellar-etl adapter: its own transforms over the canonical ledgers, scored. wallet-backend adapter: its own RPC and datastore ledger backends + `indexer.ProcessLedger`, scored; the commits before and after each upstream fix; lint with reviewed triage |
| `kit/guide/` | The hardening guide's field table, its corpus check, and the developers.stellar.org export |
| `corpus/findings.json` | The findings report: every finding with severity, upstream issue, corpus entry and the checks it explains |
| `kit/go/lint`, `kit/go/cmd/istravex-lint` | `go/analysis` rules IX001–IX003 |
| `kit/goldens/`, `kit/go/cmd/goldens` | stellar-core's `--check-lcm` golden `LedgerCloseMeta`, round-tripped by every SDK |
| `kit/audit/` | CAP coverage audit from a pinned stellar-protocol checkout |
| `server/` | The API (Hono): corpus, ledgers, results and the mock RPC over HTTP; OpenAPI in `server/openapi.json` |
| `wrangler.jsonc`, `public/_headers` | The site on Cloudflare Workers static assets (istravex.com) |
| `deploy/`, `Dockerfile` | API + RPC stack for the VPS (Docker Compose, an nginx site, certbot) and its DNS script |
| `.github/workflows/deploy.yml` | After CI: site → Cloudflare with wrangler, API image → GHCR, API → VPS |
| `actions/lint`, `.github/workflows/lint-indexer.yml` | CI templates: run istravex-lint in your own repository |
| `docs/` | Mintlify docs, published at docs.istravex.com |

```bash
npm ci
node kit/goldens/fetch.mjs    # once: stellar-core golden ledgers (~80 MB)
npm run corpus:run            # verify → SDK runners → JS release matrix → goldens → replay → site + docs data
node kit/check-results.mjs    # all green, and every reproduced failure mapped to a finding
npm run pilot:wallet-backend  # upstream pilot (clones wallet-backend into .cache/)
npm run corpus:audit          # CAP coverage audit (clones stellar-protocol into .cache/)
npm run test:kit              # mock RPC (incl. bounded memory) + data lake + linter tests
npm run guide:check           # the guide's field table agrees with the corpus
npm run guide:export          # the guide as Docusaurus Markdown, in build/guide
npm run test:api              # API tests
npm run api                   # API + mock RPC on :8080
npm run rpc -- --network pubnet --port 8000   # serve the corpus to your own indexer

# capture / generate (network or pinned core required)
npm run corpus:capture        # mainnet (pinned hashes) + testnet + canonical ledgers
npm run corpus:generate       # standalone stellar-core 30.0.0, pinned by binary sha256; deterministic
npm run corpus:generate-check # regenerate and compare every byte with the committed corpus
npm run lake -- export --out .cache/lake/istravex   # the corpus in the data-lake layout
```

Requirements: Node 24, Go 1.25, a stable Rust toolchain. `corpus:generate` and the pilot's before/after runs also need stellar-core 30.0.0 (`brew install stellar-core`); the binary is checked against `kit/capture/core-pin.json`.

Lint your own indexer:

```bash
go run github.com/hackcat29/istravex/kit/go/cmd/istravex-lint@latest ./...
```

## Site

```bash
npm run dev        # http://localhost:5173
npm run build
npm run test:e2e   # Playwright, desktop + mobile (needs: npx playwright install chromium)
```

| Path | What |
|---|---|
| `src/content.ts` | Every word on the page; numbers and XDR come from `src/data/corpus.json` |
| `src/data/corpus.json` | Generated by `kit/site-data.mjs`; do not edit by hand |
| `src/sections/*` | One file per section, in page order |
| `src/scenes/*` | Three.js WebGPU (hero), Babylon.js WebGPU (anatomy), TypeGPU (CTA), each with a WebGL2 or Canvas 2D fallback |

Design rules: solid colours only, no gradients, no italic or serif display type, no taglines or helper text, `prefers-reduced-motion` respected, no horizontal scroll on mobile.
