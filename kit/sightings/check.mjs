// Check every claim in corpus/sightings.json against the results it names,
// and write the sightings page (docs/corpus/sightings.mdx).
//
// Returns a list of failures; kit/check-results.mjs fails on any.
//   node kit/sightings/check.mjs   (prints and writes the page)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CORPUS, RESULTS, ROOT } from '../lib/fixture.mjs';

const read = (f) => JSON.parse(readFileSync(join(RESULTS, f), 'utf8'));

/** What a before/after workflow result must show, per sighting. */
const WORKFLOW = {
  'stellar/rs-soroban-sdk#2099': (r) => ({
    before: r.before.results.some((x) => x.outcome === 'panic'),
    after: r.after.results.every((x) => x.outcome === 'error'),
    shows: `soroban-sdk ${r.before.soroban_sdk}: ${r.before.results.filter((x) => x.outcome === 'panic').length} of ${r.before.results.length} non-address values panic; ${r.after.soroban_sdk}: every one returns ConversionError`,
  }),
  'stellar/js-xdr#165': (r) => ({
    before: r.before.results.every((x) => x.outcome === 'accepted'),
    after: r.after.all_rejected === true,
    shows: `${r.before.build}: all ${r.before.results.length} invalid Writer inputs written silently; ${r.after.build}: all rejected`,
  }),
  'stellar/rs-stellar-xdr#604': (r) => ({
    before: r.before.defined_in_xdr === true && r.before.in_schema === false,
    after: r.after.in_schema === true,
    shows: `stellar-xdr ${r.before.stellar_xdr}: ScAddressType's schema omits SC_ADDRESS_TYPE_MUXED_CONTRACT, which the crate defines behind a feature; ${r.after.stellar_xdr}: present`,
  }),
  'stellar/rs-stellar-xdr#581': (r) => {
    const cap = (o) => String(o).match(/^len (\d+) capacity (\d+)$/)?.slice(1).map(Number) ?? [NaN, NaN];
    const [bl, bc] = cap(r.before.outcome);
    const [al, ac] = cap(r.after.outcome);
    return {
      before: bc > bl,
      after: ac === al,
      shows: `a decoded 5-element vec reserves capacity ${bc} on stellar-xdr ${r.before.stellar_xdr} and exactly ${ac} on ${r.after.stellar_xdr}`,
    };
  },
  'stellar/rs-stellar-xdr#598': (r) => ({
    before: String(r.before.outcome).startsWith('accepted'),
    after: String(r.after.outcome).startsWith('error'),
    shows: `21 signatures into a transaction's VecM<DecoratedSignature, 20> from JSON: accepted by stellar-xdr ${r.before.stellar_xdr}, rejected by ${r.after.stellar_xdr}`,
  }),
};

export function checkSightings() {
  const { sightings } = JSON.parse(readFileSync(join(CORPUS, 'sightings.json'), 'utf8'));
  const { findings } = JSON.parse(readFileSync(join(CORPUS, 'findings.json'), 'utf8'));
  const failures = [];
  const rows = [];
  const pilotWb = existsSync(join(RESULTS, 'pilot-wallet-backend.json')) ? read('pilot-wallet-backend.json') : null;
  const etl = existsSync(join(RESULTS, 'pilot-stellar-etl.json')) ? read('pilot-stellar-etl.json') : null;
  for (const s of sightings) {
    const finding = s.finding && findings.find((f) => f.id === s.finding);
    if (s.finding && !finding) failures.push(`sighting ${s.issue}: finding ${s.finding} not in findings.json`);
    let ok = true;
    let shows = s.detail ?? '';
    if (s.status === 'reproduced') {
      if (s.evidence === 'pilot-wallet-backend') {
        const p = pilotWb?.sightings?.find((x) => x.issue === s.issue || x.fixed_by?.pr === s.issue);
        ok = Boolean(p?.reproduced);
        if (!s.detail && p) shows = `${p.before.results.map((r) => r.verdict).join(', ')} on ${p.before.ref.slice(0, 7)}; ${p.after.results.map((r) => r.verdict).join(', ')} on ${p.after.ref.slice(0, 7)}`;
      } else if (s.evidence === 'workflow') {
        const file = join(RESULTS, s.results);
        if (!existsSync(file)) ok = false;
        else {
          const v = WORKFLOW[s.issue](read(s.results));
          ok = v.before && v.after;
          shows = [v.shows, s.detail].filter(Boolean).join('. ');
        }
      } else {
        // pilot-stellar-etl and javascript-matrix: the finding's checks fail where it says.
        ok = finding?.reproduced === true;
        if (!s.detail) shows = finding?.evidence ?? '';
      }
      if (!ok) failures.push(`sighting ${s.issue}: claimed reproduced, but ${s.evidence} does not show it`);
    } else if (s.status === 'exercised') {
      if (s.evidence === 'goldens') {
        for (const sdk of ['javascript', 'go', 'rust']) {
          const g = existsSync(join(RESULTS, `goldens-${sdk}.json`)) ? read(`goldens-${sdk}.json`) : null;
          if (!g || g.exact !== g.frames) ok = false;
        }
        const g = existsSync(join(RESULTS, 'goldens-javascript.json')) ? read('goldens-javascript.json') : null;
        if (g) shows = `${g.exact.toLocaleString('en-US')} of ${g.frames.toLocaleString('en-US')} golden frames round-trip in JavaScript, Go and Rust. ${s.detail}`;
      }
      for (const f of s.fixtures ?? []) {
        if (!existsSync(join(CORPUS, 'fixtures', f, 'manifest.json'))) ok = false;
        if (s.evidence === 'pilot-stellar-etl' && etl?.results.find((r) => r.fixture === f)?.verdict !== 'correct') ok = false;
      }
      if (!ok) failures.push(`sighting ${s.issue}: claimed exercised, but ${s.evidence} does not hold`);
    }
    rows.push({ ...s, shows });
  }
  return { failures, rows };
}

function page(rows) {
  const count = (st) => rows.filter((r) => r.status === st).length;
  const link = (issue) => {
    const [repo, n] = issue.split('#');
    return `[${repo.split('/')[1]}#${n}](https://github.com/${repo}/issues/${n})`;
  };
  const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/[{}<>]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const label = { reproduced: '**reproduced**', exercised: 'exercised', 'not-covered': 'not covered' };
  return `---
title: RFP sightings
description: The 18 sightings the RFP lists, and how Istravex covers each one.
---

{/* Generated by kit/sightings/check.mjs from corpus/sightings.json. Do not edit by hand. */}

The RFP lists 18 sightings: bugs and features that motivated it. **${count('reproduced')}** are reproduced in CI: a check fails before the fix (or at the current release, when the fix is unreleased or the issue still open) and passes after it. **${count('exercised')}** are exercised: the corpus runs what they are about and checks today's behaviour, with no before/after to show. **${count('not-covered')}** ${count('not-covered') === 1 ? 'is' : 'are'} not covered, with the reason. \`kit/check-results.mjs\` checks every row against the results it names.

| Sighting | Status | Evidence |
|---|---|---|
${rows.map((r) => `| ${link(r.issue)}: ${cell(r.title)} | ${label[r.status]} | ${cell(r.shows || '—')}${r.finding ? ` ([${r.finding.replace('ISTRAVEX-', '')}](/project/findings))` : ''} |`).join('\n')}

Reproductions that need upstream builds run in [\`.github/workflows/sightings.yml\`](https://github.com/hackcat29/istravex/blob/main/.github/workflows/sightings.yml); their results are \`corpus/results/sightings-*.json\`.
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { failures, rows } = checkSightings();
  writeFileSync(join(ROOT, 'docs', 'corpus', 'sightings.mdx'), page(rows));
  for (const r of rows) console.log(r.status.padEnd(12), r.issue.padEnd(36), r.shows.slice(0, 100));
  for (const f of failures) console.log('FAIL', f);
  if (failures.length) process.exit(1);
}
