// Assert the kit's results are all green. CI runs this after the runners;
// result files themselves are not diffed because they record runtime versions.
//   node kit/check-results.mjs
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS, readCorpus } from './lib/fixture.mjs';

const read = (f) => JSON.parse(readFileSync(join(RESULTS, f), 'utf8'));
const failures = [];
const fixtures = readCorpus().map((c) => c.manifest.id);

for (const p of read('provenance.json').fixtures) {
  for (const c of p.checks) if (!c.ok) failures.push(`provenance ${p.fixture}: ${c.name}: ${c.detail}`);
}
for (const sdk of ['javascript', 'go', 'rust']) {
  const r = read(`${sdk}.json`);
  const seen = new Set(r.results.map((x) => x.fixture));
  for (const id of fixtures) if (!seen.has(id)) failures.push(`${sdk}: no result for ${id}`);
  for (const x of r.results) for (const [k, v] of Object.entries(x.checks)) if (v !== 'pass') failures.push(`${sdk} ${x.fixture} ${k}: ${x.detail.join('; ')}`);
}
for (const sdk of process.env.SKIP_GOLDENS ? [] : ['javascript', 'go', 'rust']) {
  if (!existsSync(join(RESULTS, `goldens-${sdk}.json`))) {
    failures.push(`goldens: no ${sdk} result (npm run corpus:goldens)`);
    continue;
  }
  const g = read(`goldens-${sdk}.json`);
  if (!g.frames || g.exact !== g.frames) failures.push(`goldens ${sdk}: ${g.exact}/${g.frames} frames exact`);
}
for (const row of read('replay.json').rows) {
  if (row.indexer === 'reference' && row.verdict !== 'correct') failures.push(`replay reference ${row.fixture}: ${row.verdict}`);
}
if (existsSync(join(RESULTS, 'pilot-wallet-backend.json'))) {
  const pilot = read('pilot-wallet-backend.json');
  for (const r of pilot.results) if (r.verdict !== 'correct') failures.push(`pilot wallet-backend ${r.fixture}: ${r.verdict}`);
  for (const f of pilot.lint.findings) if (f.status === 'untriaged') failures.push(`pilot lint untriaged: ${f.rule} ${f.file}:${f.line}`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`all green: ${fixtures.length} fixtures`);
