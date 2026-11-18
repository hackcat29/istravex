**Istravex — The XDR conformance and replay kit for Stellar**

### Project summary

Istravex is an open-source test kit that helps Stellar indexer and SDK maintainers verify that their software preserves what actually happened on the ledger. It uses a shared, versioned corpus of rare but valid Stellar XDR to answer two questions. Does the SDK decode and re-encode the data faithfully? Does the indexer store the right records and attribute them to the right accounts?

Built for **SCF #46 RFP 2** (XDR/CAP-Coverage Audit Tool and Indexer-Hardening Guide). Everything below is built, public and running in CI: a 137-fixture corpus that covers every XDR shape real mainnet and testnet traffic uses (chosen from a scan of 400,311 ledgers), the replay harness with two upstream indexers, a conformance runner for seven SDKs plus a sweep over 310,837 real transactions, the Go linter, the hardening guide, a findings report with seven new defects, and a security policy. The grant would fund six months of new work: generated and hostile cases for every XDR type, four more SDKs, three more indexers, three more lint rules, and the next protocol upgrade.

- Repository: https://github.com/hackcat29/istravex (Apache 2.0)
- Docs: https://docs.istravex.com · API: https://api.istravex.com · Mock RPC: https://rpc.istravex.com

### Problem

A Stellar transaction can be valid and still be misread downstream. An indexer might miss a trustline created through a Stellar Asset Contract, store a muxed address where an account belongs, or attribute an effect to the wrong account. An SDK can decode an XDR value correctly and still lose information when it converts it to a language-native value. These mistakes propagate into wallets, explorers and analytics without a visible error, and in 2026 several of them halted production ingestion outright.

A regression test added to one SDK or indexer usually stays in that repository. Istravex lets maintainers share the original fixture, its expected result and the protocol context behind it, so a fix in one implementation becomes a test for all of them.

### What it does

```mermaid
flowchart LR
  subgraph sources["Ledger data"]
    M["Mainnet and testnet<br/>SDF data lake, 400,311 ledgers scanned"]
    G["Pinned stellar-core 30.0.0<br/>standalone, reproducible"]
  end
  M --> SC["Shape scan<br/>XDR cells per transaction"]
  SC --> COVER["Set cover<br/>every cell real traffic uses"]
  COVER --> F
  subgraph corpus["Corpus"]
    F["Fixtures + manifests<br/>(CAP, protocol, expected values)"]
    L["Canonical LedgerCloseMeta"]
  end
  sources --> F
  sources --> L
  F --> V["Provenance verifier<br/>byte-identical to the ledger"]
  L --> V
  F --> R["Conformance runner<br/>JS · Go · Rust · Python ×2 · Java · PHP"]
  M --> SW["Sweep<br/>310,837 real transactions"]
  SW --> FR
  L --> RPC["Mock RPC getLedgers"]
  L --> LAKE["Data-lake layout<br/>filesystem or S3"]
  RPC --> IDX["Your indexer<br/>(piloted: wallet-backend, stellar-etl)"]
  LAKE --> IDX
  IDX --> S["Scorer<br/>correct · incorrect · dropped"]
  SRC["Indexer source (Go)"] --> LINT["istravex-lint<br/>IX001–IX003"]
  R --> FR["Findings report<br/>every failure → an upstream issue"]
  S --> FR
  LINT --> FR
  FR --> GUIDE["Hardening guide<br/>field table checked against the corpus"]
```

**In plain English.** The corpus is a folder of real Stellar transactions and ledgers, each tied to the protocol changes (CAPs) whose shapes it exercises, with the values a correct decoder and a correct indexer must produce. A scanner read 400,311 mainnet and testnet ledgers and recorded every XDR shape each transaction uses; the corpus was then chosen so that every shape real traffic uses is in it. A verifier proves every fixture is byte-identical to the ledger that recorded it. Seven small programs, one per SDK, decode every fixture and check the values, and a sweep checks five of them against stellar-core's own hashes for 310,837 real transactions. A fake Stellar RPC server, and an export in the same layout as SDF's public data lake, hand the same ledgers to any indexer, and a scorer compares what it stored with what it should have. A linter reads indexer source code for the mistakes that keep recurring. A findings file ties every failure to an issue upstream, and a guide explains each rule with the evidence.

**Stack.** Node 24 (corpus tooling, mock RPC, data-lake exporter, JavaScript runner, API), Go 1.26 (shape scanner, sweep, verifier, Go runner, `go/analysis` linter), Rust (stellar-xdr runner, the Soroban probe contract, sighting reproductions), Python 3, Java 17 and PHP 8 (their SDK runners), stellar-core 30.0.0 pinned by binary sha256, `@stellar/stellar-sdk` 17.4.0, `go-stellar-sdk` 0.9.0, `stellar-xdr` 30.0.0, Python `stellar-sdk` 17.0.1 and `stellar-xdr` 0.2.1, `java-stellar-sdk` 6.0.0, `stellar-php-sdk` 1.18.0, Mintlify for docs, GitHub Actions for CI, scans, sweeps and deploys.

### What's built

| Deliverable | What exists | RFP reviewer check |
|---|---|---|
| **Corpus and generator** | 137 fixtures: 95 from mainnet, 30 from testnet, 10 generated, 2 synthetic. 20 are hand-written patterns that broke real software; 116 were chosen by set cover so that **all 470 XDR cells real traffic uses** (union arms, flag bits, contract cost types; 603 are reachable from `LedgerCloseMeta`) are in the corpus. **45 of the 47 live CAPs that leave a ledger shape** are covered; the other 23 CAPs leave none, each with the reason. The generator runs a pinned standalone stellar-core, byte-reproducible, any passphrase, protocols 28–30. 1,794/1,794 provenance checks. | Every fixture round-trips through rs-stellar-xdr 30.0.0; all SDKs round-trip stellar-core's 15,306 `--check-lcm` golden frames. |
| **Replay harness** | Mock Stellar RPC `getLedgers` and the Galexie data-lake layout (filesystem or S3), bounded memory (542 MB of ledgers served under a 128 MB heap). Two upstream indexers replayed over every fixture with a transaction: wallet-backend's own ingestion, **123/123** correct over both inputs; stellar-etl v2.8.34's own transforms, **119/123**, the four misses being its open issues #454 and #460. | wallet-backend #729, #731 and #716 reproduce on the commits before their fixes and pass on the fixes, in CI. |
| **Linter** | Three `go/analysis` rules: unvalidated fields used as if checked (IX001), walks with no depth or size limit (IX002), participants or fees from the envelope (IX003). A GitHub Action and a reusable workflow. | Flags all six seeded violations; clean on current wallet-backend apart from one triaged latent finding; flags the code #753 and 9538b3c fixed, on the commits before them. |
| **Hardening guide** | Nine rules, a field-by-field table of what stellar-core validates and passes through (15 rows), recommended limits with sources, SEP-0023 address handling, a checklist. Exports to Docusaurus for developers.stellar.org. | The field table is generated from one file and CI checks it against every manifest. A draft: review by a stellar-core or platform engineer, which the RFP gates publication on, is requested publicly (stellar/stellar-docs#3166) and is a tranche 2 acceptance criterion. The export opens with a "Draft, not reviewed" warning until then. |
| **Conformance runner** | **Seven SDKs** in CI: `@stellar/stellar-sdk` 17.4.0, `go-stellar-sdk` 0.9.0, `stellar-xdr` 30.0.0 (Rust), Python `stellar-sdk` 17.0.1 and `stellar-xdr` 0.2.1, `java-stellar-sdk` 6.0.0, `stellar-php-sdk` 1.18.0. 2,810/2,816 checks; every failure is a finding. A **sweep** over 1,241 whole ledgers checks the SDKs against stellar-core's own bytes: every ledger round-trips, and Go, JavaScript, Rust and Python match all 310,837 transaction hashes stellar-core recorded; Java misses 58 (F-0023). Plus four JavaScript releases. | js-stellar-sdk 17.2.0 and 17.2.1 fail exactly the checks for #1766, #1785 and #1789; 17.3.0 and 17.4.0 pass. |
| **Findings report** | 24 findings: **7 new defects** the kit found (3 filed upstream, 4 drafted), 13 known bugs reproduced, 4 notes; each with severity, affected versions, disclosure route, the corpus entry and the checks it explains; served at `/v1/findings`. | CI fails on any failure that no finding explains, in the runners, the pilots and the sweeps. |

### New defects

The kit's value is the bugs it finds that nobody had reported. Seven so far:

| Finding | Component | Severity | What |
|---|---|---|---|
| F-0023 | java-stellar-sdk 6.0.0 | high | A transaction whose `PRECOND_V2` fields are all defaults is rebuilt as `PRECOND_TIME`, so its hash is wrong and signing it signs a different transaction. 58 of 307,577 mainnet transactions in the sweep; Go, JavaScript, Rust and Python hash all of them correctly. Drafted. |
| F-0024 | stellar-php-sdk 1.18.0 | high | The same defect in PHP, with the same wrong hash. Drafted. |
| F-0021 | stellar-php-sdk 1.18.0 | medium | Muxed account IDs above 2⁶³ come back negative: a real mainnet destination, 18067157809773112502, reads as -379586263936439114. Drafted. |
| F-0022 | stellar-php-sdk 1.18.0 | low | The decoder accepts 101 operations and a 29-byte memo, past their XDR maximums. Drafted. |
| F-0012 | js-stellar-sdk | low | `TransactionBuilder` refuses a muxed source or memo on every Soroban transaction. Filed: js-stellar-sdk#1906. |
| F-0010, F-0011 | stellar-core | low | Operation-meta change order differs between identical runs; settings-upgrade salts make standalone networks unreproducible. Filed: stellar-core#5507, #5508. |

The four drafted findings are filed with their maintainers on award (tranche 0); their reproductions are in the corpus today.

### Mainnet

The corpus is mainnet-first and measured against real traffic. `kit/go/cmd/shape-scan` streams SDF's public data lake and records every XDR cell each transaction and ledger exercises; a GitHub workflow runs it in 16 shards.

| Scan | Ledgers | Transactions |
|---|---|---|
| Mainnet, every 400th and every 37th ledger since 59,227,201 (Horizon's history) | 186,253 | 57,628,208 |
| Testnet since its last reset (protocol 30 since 5,540,313) | 214,046 | 2,002,380 |
| Mainnet and testnet protocol-upgrade ledgers (24–30) | 12 | 1,956 |

470 of the 603 reachable cells occur in those ledgers. The corpus covers all of them, with expected values from Horizon and bytes from the canonical ledger. Its earlier pattern scan found the hand-written patterns in production: 122,485 transactions with vectors at their maximum, 100,999 muxed IDs above 2⁵³, 63,778 authorization trees three or more deep, 5 SAC `trust()` trustlines in 400,000 ledgers.

### Security

- **Policy.** [SECURITY.md](https://github.com/hackcat29/istravex/blob/main/SECURITY.md): GitHub private vulnerability reporting, acknowledgement within 3 business days, triage within 7, a fix within 30 for high or critical issues.
- **Disclosure of what the kit finds.** Every finding records its disclosure route. A finding that could halt ingestion, corrupt balances or be triggered by anyone submitting a transaction goes privately to the maintainer, or through SDF's bug bounty for stellar-core and SDF repositories, under a 90-day embargo, before any public issue or fixture. Low-severity findings are public issues. The record is in SECURITY.md and `corpus/findings.json`.
- **Attack surface.** The kit holds no keys or funds and signs nothing outside its own standalone network. The hosted API and RPC are read-only, serve committed files, and are rate limited. Every dependency is pinned by version and, for stellar-core and the Java jars, by sha256.
- **Audit history.** No third-party audit; there is nothing custodial to audit, and audits are an ineligible cost. The kit's own correctness is checked the way it checks others: byte-identical provenance against the ledger, reproducible regeneration, and calibration against known bugs.

### Team

**Tomiwa Adeyemi, core maintainer.** Eight years in the blockchain industry, previously at Scroll Foundation and HUMAN Protocol. Winner of multiple hackathons, and a member of Stellar Nigeria. Founder of [Payrouta](https://payrouta.com), a universal checkout widget: a merchant, app, agent or store adds one checkout button, and its customers pay from whatever wallet, blockchain (Stellar included) or token they hold. Payrouta depends on reading Stellar payments correctly, which is the problem Istravex tests for. Tomiwa built everything listed above and owns fixture review, triage and releases.

### Evidence of reproducing a listed sighting

All six sightings the RFP's deliverable checks name reproduce in CI, failing before the fix and passing after:

- **wallet-backend #729** (signed-payload signers): on `2a0a84e` the signer's state change can't be encoded (a 68-byte key into a 33-byte column), so ingestion would retry the ledger forever. On `2c87335`: correct.
- **wallet-backend #731** (SAC trustlines): on `764a4f5` no `TRUSTLINE` state change is recorded. On `c152783`: correct.
- **wallet-backend #716** (fixed by #753): on `f8e5786` the muxed source's `G…` and `M…` forms collide on one participant key, which halted ingestion; IX003 flags the four lines #753 changed. On `bb0b162`: correct, and no findings.
- **js-stellar-sdk #1766, #1785, #1789**: 17.2.0 throws decoding a valid pool-share trustline and mis-sorts map keys; 17.2.1 accepts `0x…` muxed IDs, rounds offer IDs above 2⁵³, and silently drops two of ten map entries. 17.3.0 passes every check.

Of all 18 sightings the RFP lists, **13 are reproduced** before and after their fixes (or at the current release, where the fix is unreleased or the issue open): the six above plus wallet-backend #753, stellar-etl #454 and #460, rs-stellar-xdr #581 and #598, rs-soroban-sdk #2099 and js-xdr #165. Three are exercised without a before/after (stellar-core #5435's goldens, stellar-etl #470's protocol 28 XDR, js-stellar-sdk #1823's documented behaviour), and two are out of reach with the reason (henyey #3941 is bucket parsing; rs-stellar-xdr #604 is a schema-file defect no release shows). The registry and its checks: https://docs.istravex.com/corpus/sightings.

### Infrastructure and decentralization

Nothing in the kit depends on a server Istravex runs. Every tool runs locally or in a user's CI from a clone: the corpus, verifier, runners, mock RPC, data-lake exporter, scorer and linter. The hosted services are conveniences over the same files: istravex.com (static site, Cloudflare Workers), docs.istravex.com (Mintlify), and api.istravex.com and rpc.istravex.com (one read-only container on a VPS, deployed by GitHub Actions, and self-hostable as one Docker image). Mainnet fixtures are pinned to SDF's public data lake by sha256, so anyone can re-derive them independently.

### User tracking

Minimal, and documented at https://docs.istravex.com/project/maintenance#user-tracking. Istravex adds no cookies, analytics or request logs anywhere: Cloudflare Workers observability and nginx access logs are off. The API keeps a per-IP rate-limit counter in memory for one minute. Mintlify records docs page views for its own dashboard, as it does for every site it hosts. The kit's tools collect nothing.

### Budget and tranches

Everything above is built and is not part of the request: past work is ineligible. The award would fund six months of new work.

**Request: $90,000 in XLM.** 1,180 engineering hours at $75 an hour, plus $1,500 of infrastructure.

| Work | Hours | Cost |
|---|---|---|
| Generated cases: a value of every XDR type and arm, and hostile variants of each (non-zero padding, a bool or optional flag other than 0 or 1, a length over the maximum, an absurd length prefix, trailing bytes, truncation), through every SDK, with stellar-core's own decoder as the oracle | 200 | $15,000 |
| Four more SDKs: Swift (`stellar-ios-mac-sdk`), Dart (`stellar_flutter_sdk`), .NET (`dotnet-stellar-sdk`) and Kotlin; high-level checks on the hand-written patterns for every SDK; release matrices for all of them | 220 | $16,500 |
| Indexers: Horizon's ingestion processors, SDF's token transfer processor (CAP-0067 events), and one community indexer chosen with SCF reviewers | 180 | $13,500 |
| Network coverage that keeps up: the shape scan and the sweep on every week's new ledgers, fixtures captured automatically for any new cell, a monthly report; CAP-0070 and CAP-0083 closed | 140 | $10,500 |
| Linter rules IX004 (amounts through floats), IX005 (effects read from operations, not metadata) and IX006 (unbounded strkey and memo decoding), calibrated like IX001–IX003 | 100 | $7,500 |
| Guide v2: new rules from the new findings, the engineer review the RFP requires, a pull request to developers.stellar.org | 80 | $6,000 |
| The next protocol upgrade end to end: re-pin, rescan, regenerate, re-run, release within two weeks of the mainnet vote | 120 | $9,000 |
| Maintenance: filing and following every finding upstream (four drafted today), triage, dependency updates, releases | 140 | $10,500 |
| Infrastructure: the API and RPC host, domains, storage for the data-lake export | | $1,500 |
| **Total** | **1,180** | **$90,000** |

For comparison: SCF #45 made four RFP-track awards totalling $445,000 (about $111,000 each); SCF #44 awarded LumenWipe $120,000; SCF #41 awarded a Soroban reverse-engineering tool $120,000; SCF #40 awarded a Unity kit $47,000. Istravex asks for less than the RFP-track average because most of the kit is already built.

| Tranche | Share | Amount | Due | Deliverables (each testable from a clean checkout or a public link) |
|---|---|---|---|---|
| **T0 · Award** | 10% | $9,000 | On award | Funded-work plan published as GitHub milestones; the four drafted findings filed upstream; the shape scan and sweep running weekly |
| **T1 · MVP** | 20% | $18,000 | Month 2 | Generated and hostile cases for every XDR type through all seven SDKs, judged by stellar-core; the Swift runner in CI; IX004 flags its seeded violation and stellar-etl's float amounts |
| **T2 · Testnet** (public beta) | 30% | $27,000 | Month 4 | Dart, .NET and Kotlin runners and release matrices for every SDK in CI; the Horizon and token-transfer-processor pilots scored over RPC and the data lake; IX005 and IX006; the guide reviewed by a stellar-core or platform engineer and proposed to developers.stellar.org; v1.4 released |
| **T3 · Mainnet** (production release) | 40% | $36,000 | Month 6 | The next protocol upgrade covered end to end (or, if its vote is later, its release candidate); the community-indexer pilot; every open finding followed up upstream; v2.0.0 released; a six-month maintenance report |

Each tranche follows the previous payment within 90 days, and every deliverable is checked by a command or a link a reviewer can open.

### Community

Istravex is promoted, and its results are posted, on every Stellar channel available to it:

- **Stellar's developer Discord**, in the SCF and developer channels: each release, each new finding, and a call for indexers to pilot.
- **Stellar Nigeria**, where the maintainer is a member: workshops on running the kit against your own indexer.
- **GitHub**: releases with notes, Discussions for questions and fixture proposals, and issues filed upstream for every finding.
- **The docs changelog** at docs.istravex.com, and the monthly rare-pattern report.
- **X, Bluesky, Mastodon and Matrix**: release and report announcements from the maintainer's accounts.
- **SCF**: tranche reports in the format the handbook asks for, and the six-month maintenance report.

### Open-source maintenance

Apache 2.0, developed in public, with tagged releases and a public changelog. Tomiwa Adeyemi owns fixture review, dependency updates, issue triage and releases for six months after delivery, through the first protocol upgrade after it. On that upgrade, every step is a command and CI stays red until it's done: audit the new CAPs, re-pin stellar-core, move the SDK pins and the probe contract, regenerate (and prove regeneration reproducible on both platforms), re-run the pilot, triage any new failure into a finding with an upstream issue, and release. Progress is posted on every channel listed under Community with each release.
