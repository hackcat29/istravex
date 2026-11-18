# Security policy

Istravex exists to find defects in software that reads the Stellar ledger. Some of those defects can be exploited: a single cheap transaction halted stellar/wallet-backend's ingestion until #753 fixed it. So this policy covers two things: vulnerabilities **in Istravex**, and vulnerabilities **Istravex finds in other projects**.

## Reporting a vulnerability in Istravex

Report privately through GitHub: **Security → Report a vulnerability** on https://github.com/hackcat29/istravex (private vulnerability reporting is enabled). Please don't open a public issue.

In scope: the kit (`kit/`), the API and mock RPC (`server/`, api.istravex.com, rpc.istravex.com), the site (istravex.com), the docs build, the GitHub Action and reusable workflow, and the release artefacts. A corpus fixture that is wrong (its bytes don't match the ledger, or an expected value is wrong) is a bug, not a vulnerability: open a normal issue.

| Step | Target |
|---|---|
| Acknowledge the report | 3 business days |
| Confirm or rule it out, with a severity | 7 days |
| Fix released (or mitigated on the hosted services) | 30 days for high or critical, otherwise the next release |
| Public advisory, crediting the reporter if they wish | when the fix ships |

Supported versions: the latest release and `main`. The hosted services always run `main`.

## How Istravex discloses what it finds in others

Every finding is triaged on the severity scale in [`corpus/findings.json`](corpus/findings.json) before anything is published.

- **Exploitable by a third party, or high or critical severity** (anything that halts or corrupts ingestion, mis-attributes funds, crashes a node or a decoder, or bypasses validation): reported **privately** first.
  - Projects covered by SDF's bug bounty (stellar-core, the SDKs, stellar-etl, wallet-backend and other SDF repositories): through the [SDF bug bounty program](https://stellar.org/grants-and-funding/bug-bounty).
  - Other projects: their security policy, or GitHub private vulnerability reporting, or their maintainers directly.
  - The fixture that reproduces it stays out of the public corpus, and the finding out of the public report, until a fix is released or 90 days have passed, whichever is first (extended on request while a fix is in progress).
- **Medium, low or informational, and not exploitable by a third party** (a wrong value or a rejected valid value with no attacker path, reproducibility, ergonomics, documentation): filed as a public issue, with a link to the fixture.

`findings.json` records how each finding was disclosed in its `disclosure` field.

## Disclosure record

| Finding | Severity | Disclosure |
|---|---|---|
| F-0001–F-0009 | high to info | Reproductions of defects already fixed and public upstream; nothing to disclose. |
| F-0010 (stellar-core#5507), F-0011 (stellar-core#5508), F-0012 (js-stellar-sdk#1906) | low | Public issues, 15 November 2026: they affect reproducibility and SDK ergonomics, not validation, funds or availability. |
| F-0013–F-0015 | low / info | Not exploitable (latent or by design); documented in the report. |

No private disclosure has been needed so far. When one is, it will appear here after publication.

## Contact

Use GitHub private vulnerability reporting. The maintainer is Tomiwa Adeyemi ([@hackcat29](https://github.com/hackcat29)).
