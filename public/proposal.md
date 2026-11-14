**Istravex — The XDR conformance and replay kit for Stellar**

### Project summary

Istravex is an open-source test kit that helps Stellar indexer and SDK maintainers verify that their software preserves what actually happened on the ledger. It uses a shared, versioned corpus of rare but valid Stellar XDR to answer two questions. Does the SDK decode and re-encode the data faithfully? Does the indexer store the right records and attribute them to the right accounts?

Built for **SCF #46 RFP 2**, Istravex will deliver a CAP coverage audit, a reproducible fixture generator, an offline replay harness, a JavaScript, Go, and Rust conformance runner, and a Go linter backed by a practical indexer-hardening guide.

### Problem

A Stellar transaction can be valid and still be misread downstream. An indexer might miss a trustline created through a Stellar Asset Contract, discard the ID from a muxed address, or attribute an effect to the wrong account. An SDK can successfully decode an XDR value and still lose information when it converts that value into a language-native representation. Those mistakes can propagate into wallets, explorers, and analytics without a visible error.

Today, a regression test added to one SDK or indexer often stays in that repository. Istravex will let maintainers share the original fixture, its expected result, and the protocol context behind it. That makes a fix in one implementation testable across the ecosystem.

### What we will build

**1. A versioned XDR corpus and CAP coverage audit.** Each fixture will be tied to the relevant Core Advancement Proposal (CAP) and protocol version. The corpus will use captured ledger data and fixtures reproducibly generated with a pinned `stellar-core` build. Hand-authored entries will be explicitly labeled synthetic. Where canonical `LedgerCloseMeta` outputs are available, we will check our fixtures against Stellar Core’s `--check-lcm` goldens. The coverage report will show which ledger patterns each CAP introduced or changed, which have fixtures, and where gaps remain.

**2. An offline indexer replay harness.** We propose starting with a mock Stellar RPC `getLedgers` endpoint and a reference adapter for `wallet-backend`. The harness will feed fixed ledger sequences through the ingestion pipeline and compare indexed records against expected effects. Its report will distinguish a correct result, an incorrect result, and a record that was silently dropped. Each result will identify the fixture, affected CAP, indexer version, and observed output. Replay will stream fixture data with bounded memory and run locally or in CI without network credentials or funds.

**3. A cross-SDK conformance runner.** Pinned JavaScript, Go, and Rust adapters will run the same fixtures in CI. They will compare decoded values with fixture expectations, check byte-for-byte re-encoding where applicable, and exercise higher-level conversions where information can be lost. The report will identify the SDK version and the exact field or behavior that differed. Fixed-width identifiers and other large integers will retain their full precision in comparisons.

**4. A Go linter and indexer-hardening guide.** The linter will flag three ingestion patterns: trusting transaction fields passed through by Stellar Core, processing recursive XDR values without size or depth limits, and deriving affected participants from the envelope where ledger metadata supplies the relevant effects. The guide will document field-level validation guarantees, explain muxed accounts and signed-payload signers, and give maintainers a checklist they can apply in any language. We will seek review from a Stellar Core or platform engineer before publication.

**5. An upstream pilot and findings report.** We will run the corpus against `wallet-backend` and publish a triaged report. Confirmed findings will include the affected component and version, fixture ID, relevant CAP, severity, expected and observed behavior, and upstream issue link. When a divergence affects multiple SDKs, their maintainers will receive reports linked to the same fixture.

### Draft manifest and example entries

Each entry will record `id`, `cap_ids`, `protocol_version`, `network`, `xdr_type`, `xdr_path`, `sha256`, `source`, `synthetic`, `expected_decoded`, and `expected_indexed` where applicable. Provenance will identify the source ledger or the pinned generation recipe. Wide integers will be stored as decimal strings.

| Proposed fixture | Expected result |
|---|---|
| Signed-payload signer under CAP-0040 | Decoding preserves the signer type, public key, and payload bytes. |
| Stellar Asset Contract trustline under CAP-0073 | Indexed output records the trustline activity supported by ledger metadata even when a conventional trustline state change is absent. |
| Muxed payment recipient | Decoding preserves the underlying account and the full muxed ID. Indexed output retains the recipient identity supported by ledger metadata. |

### Delivery milestones

| Milestone | Acceptance criteria |
|---|---|
| **1. Corpus and reference replay** | Publish a starter corpus, fixture generator, manifest schema, and reference adapter. A clean checkout can validate fixture provenance and replay the same sequence offline with stable results. |
| **2. Conformance and linting** | JavaScript, Go, and Rust run the shared corpus in CI and produce a per-fixture results matrix. The Go linter flags fixtures for all three rules and passes on the agreed clean reference. |
| **3. Upstream pilot and public release** | Publish the `wallet-backend` findings and upstream links, complete engineering review of the guide, and ship a tagged release with adapter documentation and CI templates. |

### Open-source maintenance

We propose Apache 2.0 licensing and public development, with repository-based releases and regular updates to the Stellar community. A named maintainer will own fixture review, dependency updates, issue triage, and releases for a proposed six months after launch, including coverage through the first Stellar protocol upgrade after delivery. For that upgrade, we will review the relevant CAPs, add or update fixtures, and publish compatibility results for the supported SDK versions. Istravex will run locally without collecting usage telemetry.

The table contains **proposed fixture entries**. The full RFP application still needs actual sample XDR and evidence of one reproduced case. The mock RPC entry point, Go linter, Apache 2.0 license, and six-month maintenance period are proposed commitments. [Official SCF RFP scope](https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/rfp-track)
