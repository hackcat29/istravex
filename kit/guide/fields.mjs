// The hardening guide's field table (kit/guide/fields.json) against the corpus.
//
// The table agrees with the corpus manifests when:
//   - every pattern a row names exists in the corpus,
//   - every manifest key a row names is set by some fixture of those patterns,
//   - every expected_decoded / expected_indexed key in the corpus is named by
//     some row (a new fixture can't add an unclassified field).
//
//   node kit/guide/fields.mjs     print the disagreements, exit 1 if any
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, readCorpus } from '../lib/fixture.mjs';

export const FIELDS = JSON.parse(readFileSync(join(ROOT, 'kit', 'guide', 'fields.json'), 'utf8'));

export function checkFields(corpus = readCorpus()) {
  const problems = [];
  const byPattern = new Map();
  for (const { manifest: m } of corpus) {
    const keys = byPattern.get(m.pattern) ?? new Set();
    for (const section of ['expected_decoded', 'expected_indexed']) for (const k of Object.keys(m[section] ?? {})) keys.add(`${section}.${k}`);
    byPattern.set(m.pattern, keys);
  }
  const named = new Set();
  for (const row of FIELDS.rows) {
    for (const p of row.patterns) if (!byPattern.has(p)) problems.push(`${row.field}: no fixture has pattern ${p}`);
    for (const k of row.keys) {
      named.add(k);
      if (!row.patterns.some((p) => byPattern.get(p)?.has(k))) problems.push(`${row.field}: ${k} is set by no fixture of ${row.patterns.join(', ')}`);
    }
  }
  for (const [p, keys] of byPattern) for (const k of keys) if (!named.has(k)) problems.push(`${k} (pattern ${p}) is in no row of kit/guide/fields.json`);
  return problems;
}

const anchor = { yes: '✓ validated', partly: '◐ partly', no: '✗ passed through' };

/** The table as Markdown, for docs/snippets/field-table.mdx. */
export function fieldTable() {
  const code = (s) => `\`${s}\``;
  return `| Field | stellar-core | What it checks | What it passes through | Corpus | Guide |
|---|---|---|---|---|---|
${FIELDS.rows
  .map(
    (r) =>
      `| **${r.field}**<br />${code(r.xdr)} | ${anchor[r.validated]} | ${r.checks} | ${r.passes} | ${r.patterns.map(code).join(', ')} | ${r.rule ? `[${r.rule}](/guide/${r.rule})` : '—'}${r.lint ? ` · ${r.lint}` : ''} |`,
  )
  .join('\n')}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = checkFields();
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`field table agrees with the corpus: ${FIELDS.rows.length} rows`);
}
