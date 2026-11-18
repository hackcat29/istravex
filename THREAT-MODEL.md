# Threat model and monitoring plan

Istravex holds no funds and no keys, deploys no contracts, and signs nothing outside its own standalone test network. Its risk is different: people use it to decide whether their SDK or indexer is correct. So the threats that matter are the ones that would make it **give a wrong answer** (pass broken software, or fail correct software), **stop answering**, or **leak** a vulnerability before its owner can fix it.

This follows SDF's threat-modelling template: the four questions, with STRIDE for the second. The monitoring plan at the end is what runs, today, to notice each threat. Owner of every control and monitor: the maintainer, Tomiwa Adeyemi ([@hackcat29](https://github.com/hackcat29)). Reviewed with each release.

## 1. What are we working on?

| Component | What it is | Trust boundary |
|---|---|---|
| **Corpus** | `corpus/fixtures` (137 fixtures), `corpus/ledgers` (canonical `LedgerCloseMeta`), `corpus/generated` (45,144 generated cases), `corpus/scan` | Data from SDF's public data lake, Horizon, testnet and a pinned stellar-core enters here |
| **Capture and generation** | `kit/capture`, `kit/go/cmd/shape-scan`, the Rust case generator, the standalone stellar-core generator | Reads public networks; runs a pinned stellar-core binary |
| **Checks** | The SDK runners, the sweep, the indexer pilots, the linter, `kit/check-results.mjs` | Runs third-party code (seven SDKs, wallet-backend, stellar-etl, Horizon with a throwaway local PostgreSQL) pinned by version or commit |
| **Hosted services** | api.istravex.com and rpc.istravex.com (one read-only container on a shared VPS behind nginx), istravex.com (Cloudflare Workers static assets), docs.istravex.com (Mintlify) | Public internet |
| **CI/CD and releases** | GitHub Actions; deploys by SSH and Cloudflare token; tagged releases, the Go module, the GitHub Action | Repository secrets |
| **Findings** | `corpus/findings.json`, drafts for issues not yet filed | Vulnerabilities in other projects before they are fixed |

Data flow: public ledger data → capture (bytes pinned by sha256 to the canonical ledger) → fixtures and cases → SDKs and indexers under test → results → gate → findings → upstream issues. The hosted services only serve committed files.

## 2. What can go wrong? (STRIDE)

| # | Threat | Category | Component | Impact |
|---|---|---|---|---|
| T1 | A fixture's bytes don't match what the network recorded (a corrupted download, a bug in capture, a hand edit) | Tampering | Corpus | Wrong answers: SDKs judged against bytes the network never produced |
| T2 | An expected value is wrong, or derived from an SDK under test (so the SDK grades itself) | Tampering | Corpus | Wrong answers that look independent |
| T3 | A malicious or compromised upstream release (an SDK, stellar-etl, wallet-backend, Horizon, stellar-core) runs in CI | Elevation of privilege | Checks, CI | Secrets exposed; results forged |
| T4 | A dependency changes under a version range (an npm, crates, PyPI or Maven artefact replaced) | Tampering | Checks, CI | Results that can't be reproduced, or a supply-chain compromise |
| T5 | A hostile corpus entry (huge length prefix, deep nesting) exhausts a runner or the hosted RPC | Denial of service | Checks, hosted services | CI or the service stops answering |
| T6 | The hosted API or RPC is flooded | Denial of service | Hosted services | Unavailable to users, and to the other projects sharing the VPS |
| T7 | A deploy key or Cloudflare token leaks | Elevation of privilege, spoofing | CI/CD | Someone else serves content as istravex.com or api.istravex.com |
| T8 | A release or the Action is replaced, or a tag moved, after users pinned it | Tampering, spoofing | Releases | Users run something other than what was reviewed |
| T9 | An exploitable finding (an ingestion halt, a crash) is published before its owner fixes it | Information disclosure | Findings | Someone attacks a production indexer or SDK user with the fixture |
| T10 | The hosted services log who uses them | Information disclosure | Hosted services | User tracking the project said it doesn't do |
| T11 | Results drift silently: an upstream releases, the protocol upgrades, and the kit keeps reporting the old answer | Repudiation (of a stale claim) | Checks | Users trust a green result that no longer means anything |
| T12 | A claim in the docs or proposal isn't backed by a result (a review that didn't happen, a count that changed) | Repudiation | Docs | Reviewers and users are misled |

## 3. What are we going to do about it?

| # | Control | Where |
|---|---|---|
| T1 | Every non-synthetic fixture is byte-compared with its canonical ledger, and every stored ledger by sha256, on every push (1,794 checks). Mainnet and testnet ledgers are the data lake's objects, byte for byte. | `kit/go/cmd/verify`, CI |
| T2 | Expected values come from Horizon, the transaction as constructed, or stellar-core's own records (hashes in the ledger's results), never from an SDK under test; each manifest records its source. Generated cases are judged by the reference decoder and by stellar-core's `print-xdr`. | `kit/capture`, `kit/cases/core-oracle.mjs` |
| T3 | Upstreams are pinned by exact version, commit or binary sha256; pilots build at pinned commits. CI jobs get read-only `contents` permission, and deploy secrets are only in the deploy workflow's environments, which run from `main` after CI passes. | Workflows, `deploy.yml` |
| T4 | Lockfiles (`package-lock.json`, `go.sum`, `Cargo.lock`), exact pins for Python and PHP, sha256-pinned Java jars and stellar-core binary. | Repository |
| T5 | Decoders run with bounded limits (depth 500, length the input's); the mock RPC is tested to serve 542 MB of ledgers under a 128 MB heap; pages stop at 16 MiB. | `kit/rpc`, `kit/runners/rust` |
| T6 | Per-IP rate limit (1,200 requests a minute), request body limit, read-only container with no privileges, nginx in front. Everything the services serve can be run locally from a clone. | `server/`, `deploy/` |
| T7 | Secrets live only in the `production-site` and `production-api` GitHub environments, used by the deploy workflow alone; deploys run from `main`, after CI passes (`workflow_run`). The VPS footprint is one container, one nginx site and one certificate, and the Cloudflare token deploys Workers. Rotated on any suspicion. | `deploy.yml`, `deploy/`, GitHub settings |
| T8 | Tags are never moved except `v1` (documented); releases carry `SHA256SUMS` and GitHub build-provenance attestations, and the release workflow refuses a tag whose commit isn't on `main` with passing CI. | `.github/workflows/release.yml` |
| T9 | Every finding is triaged on the severity scale before publication; exploitable, high or critical findings go privately first (SDF's bug bounty for SDF projects) under a 90-day embargo, with the fixture held back. | `SECURITY.md`, `findings.json` `disclosure` |
| T10 | No cookies or analytics; Workers observability and nginx access logs off; the rate limiter keeps a counter in memory for one minute. | `docs/project/maintenance` |
| T11 | Weekly monitors (below), the sweep over real traffic, and a release matrix that shows each fix landing. | `monitor.yml`, `sweep.yml` |
| T12 | The gate checks claims against results: the docs numbers are generated from the corpus, every RFP sighting in `corpus/sightings.json` is checked against the results it names, and no page may claim a guide review that `kit/guide/review.json` doesn't record. | `kit/check-results.mjs`, `kit/site-data.mjs` |

## 4. Did we do a good job?

- Each control has a check that fails CI when it stops holding (T1, T2, T5, T12), or a monitor that opens an issue (T6, T11).
- The kit is calibrated against known bugs: it must fail the releases and commits before each upstream fix and pass the fixes. A control that stopped working would show up as a reproduction that no longer reproduces.
- Open: no third-party audit (the kit holds nothing to steal, and audits are an ineligible SCF cost); the guide's engineering review is requested, not done; T3 relies on pinning and least privilege, not on sandboxing third-party code.

## Monitoring plan

| Signal | How it's watched | Threshold | Response | Threat |
|---|---|---|---|---|
| A pinned upstream has a newer release | `monitor.yml`, weekly: `kit/monitor/drift.mjs` against npm, the Go proxy, crates.io, PyPI, Maven Central and GitHub releases; wallet-backend's `main` | Any newer release | One issue per release with the checklist to move the pin; new failures become findings | T11 |
| The hosted services stop answering correctly | `monitor.yml`, weekly: the API's stats, the mock RPC's `getHealth`, the docs and the site | Any failed check | Opens (or comments on) one issue; fix within the security policy's targets | T6 |
| Real traffic uses a shape the corpus lacks | `monitor.yml`, weekly: the past week's mainnet and testnet ledgers through `shape-scan` | Any cell not in `corpus/cells.json` | Issue listing the cells; `kit/capture/shapes.mjs` captures fixtures for them | T11 |
| A corpus file, ledger or result stops matching | CI on every push | Any failure | `main` doesn't deploy until fixed | T1, T2, T12 |
| An SDK starts mishandling real traffic | `sweep.yml` over a thousand mainnet ledgers and the newest testnet ones | Any check not explained by a finding | New finding, triaged and disclosed per `SECURITY.md` | T11 |
| A reported vulnerability in Istravex | GitHub private vulnerability reporting | Any report | `SECURITY.md`: acknowledge in 3 business days, triage in 7, fix in 30 for high or critical | T3–T10 |
