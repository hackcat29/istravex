// Assert the kit's results are all green, and that every failure the kit
// reproduces on purpose (earlier SDK releases, pre-fix commits) is explained
// by a finding in corpus/findings.json that links its upstream issue.
// CI runs this after the runners; result files themselves are not diffed
// because they record runtime versions.
//   node kit/check-results.mjs
//   node kit/check-results.mjs --runners-only   provenance and the three SDK runners only
//                                                (for a generated copy: ISTRAVEX_CORPUS=<dir>)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { checkSightings } from './sightings/check.mjs';
import { CORPUS, RESULTS, ROOT, readCorpus } from './lib/fixture.mjs';
import { checkFields } from './guide/fields.mjs';

const read = (f) => JSON.parse(readFileSync(join(RESULTS, f), 'utf8'));
const failures = [];
const fixtures = readCorpus().map((c) => c.manifest.id);
const negative = new Set(readCorpus().filter((c) => c.manifest.files.every((f) => f.expect === 'decode_error')).map((c) => c.manifest.id));
const runnersOnly = process.argv.includes('--runners-only');
const { findings } = runnersOnly ? { findings: [] } : JSON.parse(readFileSync(join(CORPUS, 'findings.json'), 'utf8'));
const explained = new Map(findings.flatMap((f) => f.checks.map((c) => [c, f])));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

for (const p of read('provenance.json').fixtures) {
  for (const c of p.checks) if (!c.ok) failures.push(`provenance ${p.fixture}: ${c.name}: ${c.detail}`);
}
// The current pin of every SDK passes everything, except checks that a finding
// explains as a known bug with no fixed release yet (open upstream, or fixed
// on the default branch but unreleased).
const openUpstream = (key) => {
  const f = explained.get(key);
  return f?.status === 'open-upstream' || f?.status === 'to-file' || (f?.status === 'fixed-upstream' && /unreleased/.test(f.fixed_in ?? ''));
};
for (const sdk of ['javascript', 'go', 'rust', 'python', 'python-xdr', 'java', 'php']) {
  if (['python', 'python-xdr', 'java', 'php'].includes(sdk) && runnersOnly && !existsSync(join(RESULTS, `${sdk}.json`))) continue;
  const r = read(`${sdk}.json`);
  const seen = new Set(r.results.map((x) => x.fixture));
  for (const id of fixtures) if (!seen.has(id)) failures.push(`${sdk}: no result for ${id}`);
  for (const x of r.results) {
    const known = (x.failed ?? []).filter((c) => openUpstream(`${sdk}:${x.fixture}:${c}`));
    for (const [k, v] of Object.entries(x.checks)) {
      // stellar-xdr (Python) has no high-level forms: native checks apply to the generic profiles only.
      const ok = v === 'pass' || (v === 'n/a' && negative.has(x.fixture) && k !== 'decode') || (v === 'n/a' && k === 'native' && ['python-xdr', 'php'].includes(sdk)) || (v === 'fail' && known.length && known.length === x.failed.length);
      if (!ok) failures.push(`${sdk} ${x.fixture} ${k}: ${v}: ${x.detail.join('; ')}`);
    }
  }
}

if (runnersOnly) {
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log(`runners green: ${fixtures.length} fixtures in ${CORPUS}`);
  process.exit(0);
}

// Findings that claim a failing check on a current SDK pin must be right.
for (const sdk of ['python', 'python-xdr', 'java', 'php']) {
  if (!existsSync(join(RESULTS, `${sdk}.json`))) continue;
  const failing = new Set(read(`${sdk}.json`).results.flatMap((x) => (x.failed ?? []).map((c) => `${sdk}:${x.fixture}:${c}`)));
  for (const key of explained.keys()) if (key.startsWith(`${sdk}:`) && !failing.has(key)) failures.push(`finding ${explained.get(key).id} claims ${key}, which passes`);
}

// The JavaScript matrix: earlier releases may fail, but only on checks a
// finding explains; the current pin must pass everything; and every check a
// finding claims must really fail somewhere and pass now.
if (existsSync(join(RESULTS, 'javascript-matrix.json'))) {
  const m = read('javascript-matrix.json');
  const failedAnywhere = new Set();
  const current = m.versions.at(-1);
  for (const v of m.versions) {
    for (const x of v.results) {
      for (const c of x.failed) {
        const key = `javascript-matrix:${x.fixture}:${c}`;
        failedAnywhere.add(key);
        if (v === current) failures.push(`javascript ${v.version} (current) ${x.fixture}: ${c}`);
        else if (!explained.has(key)) failures.push(`javascript ${v.version} ${x.fixture}: ${c} fails and no finding explains it (corpus/findings.json)`);
      }
    }
  }
  for (const key of explained.keys()) if (key.startsWith('javascript-matrix:') && !failedAnywhere.has(key)) failures.push(`finding ${explained.get(key).id} claims ${key}, which fails on no release`);
} else failures.push('javascript-matrix.json missing (node kit/runners/js/matrix.mjs)');

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
  if (!pilot.datastore?.results?.length) failures.push('pilot: no data-lake (datastore) run');
  for (const r of pilot.datastore?.results ?? []) if (r.verdict !== 'correct') failures.push(`pilot wallet-backend (data lake) ${r.fixture}: ${r.verdict}`);
  for (const f of pilot.lint.findings) if (f.status === 'untriaged') failures.push(`pilot lint untriaged: ${f.rule} ${f.file}:${f.line}`);
  // Every sighting reproduces, and every failure it shows maps to a finding.
  if (!pilot.sightings?.length) failures.push('pilot: no sightings run (node kit/pilot/wallet-backend.mjs)');
  for (const s of pilot.sightings ?? []) {
    if (!s.reproduced) failures.push(`sighting ${s.issue}: not reproduced`);
    for (const r of s.before.results) {
      for (const f of r.failed) {
        const key = `pilot-sighting:${r.fixture}:${slug(f.split(':')[0])}`;
        if (!explained.has(key)) failures.push(`sighting ${s.issue}: ${key} has no finding`);
      }
    }
    for (const rule of s.lint_rules ?? []) {
      const key = `lint:wallet-backend-${s.before.ref.slice(0, 7)}:${rule}`;
      if (!explained.has(key)) failures.push(`sighting ${s.issue}: ${key} has no finding`);
    }
  }
}
// The guide's field-by-field table agrees with the corpus manifests.
for (const p of checkFields()) failures.push(`guide field table: ${p}`);

// stellar-etl: every failing check is explained by a finding, and every check
// a finding claims really fails.
if (existsSync(join(RESULTS, 'pilot-stellar-etl.json'))) {
  const etl = read('pilot-stellar-etl.json');
  const failing = new Set();
  for (const r of etl.results) {
    for (const c of r.checks.filter((x) => !x.ok)) {
      const key = `pilot-stellar-etl:${r.fixture}:${slug(c.field)}`;
      failing.add(key);
      if (!explained.has(key)) failures.push(`stellar-etl ${r.fixture}: ${c.field} fails and no finding explains it`);
    }
  }
  for (const key of explained.keys()) if (key.startsWith('pilot-stellar-etl:') && !failing.has(key)) failures.push(`finding ${explained.get(key).id} claims ${key}, which passes`);
} else failures.push('pilot-stellar-etl.json missing (node kit/pilot/stellar-etl.mjs)');

// Horizon: the same rule. A dropped transaction or a reingest error fails
// unless a finding claims it.
if (existsSync(join(RESULTS, 'pilot-horizon.json'))) {
  const hz = read('pilot-horizon.json');
  const failing = new Set();
  for (const r of hz.results) {
    for (const c of r.checks.filter((x) => !x.ok)) {
      const key = `pilot-horizon:${r.fixture}:${slug(c.field)}`;
      failing.add(key);
      if (!explained.has(key)) failures.push(`horizon ${r.fixture}: ${c.field} fails and no finding explains it`);
    }
  }
  for (const [ledger, err] of Object.entries(hz.reingest_errors ?? {})) if (!explained.has(`pilot-horizon:${ledger.replace("/", "-")}:reingest`)) failures.push(`horizon reingest ${ledger}: ${err}`);
  for (const key of explained.keys()) if (key.startsWith('pilot-horizon:') && !failing.has(key) && !key.endsWith(':reingest')) failures.push(`finding ${explained.get(key).id} claims ${key}, which passes`);
} else failures.push('pilot-horizon.json missing (node kit/pilot/horizon.mjs)');

for (const f of findings) {
  if (['fixed-upstream', 'open-upstream'].includes(f.status) && !f.issue) failures.push(`finding ${f.id}: ${f.status} without an upstream issue`);
  if (f.status === 'to-file' && !f.draft) failures.push(`finding ${f.id}: to-file without a draft`);
  for (const id of f.fixtures) if (!fixtures.includes(id)) failures.push(`finding ${f.id}: unknown fixture ${id}`);
}

// The sweeps over real traffic: every failure is a finding's.
// Python's sweep is the slowest; it is checked when its results are present.
for (const sdk of ['go', 'rust', 'javascript', 'python', 'java']) {
  const file = `sweep-${sdk}.json`;
  if (!existsSync(join(RESULTS, file))) {
    if (!runnersOnly && sdk !== 'python') failures.push(`${file} missing (.github/workflows/sweep.yml)`);
    continue;
  }
  const sw = read(file);
  for (const net of ['pubnet', 'testnet']) {
    const r = sw[net];
    if (!r?.checks) failures.push(`${file}: no ${net} run`);
    else if (r.passed !== r.checks) {
      const unexplained = r.failures.filter((x) => !explained.has(`sweep-${sdk}:${net}:${x.check}`));
      for (const x of unexplained) failures.push(`sweep ${sdk} ${net} ledger ${x.ledger}: ${x.check} fails (${x.detail}) and no finding explains it`);
    }
  }
}

// The guide's review: no page may claim one that kit/guide/review.json doesn't record.
{
  const review = JSON.parse(readFileSync(join(ROOT, 'kit', 'guide', 'review.json'), 'utf8'));
  if (review.status !== 'reviewed') {
    const claim = /reviewed (and confirmed )?by an? (stellar[ -]core|core|platform|sdf) engineer/i;
    const files = ['README.md', 'public/proposal.md', 'public/llms.txt', 'src/content.ts', ...readdirSync(join(ROOT, 'docs'), { recursive: true }).filter((f) => f.endsWith('.mdx')).map((f) => join('docs', f))];
    for (const f of files) {
      const text = readFileSync(join(ROOT, f), 'utf8');
      if (claim.test(text)) failures.push(`${f} claims the guide was reviewed, but kit/guide/review.json says ${review.status}`);
    }
  }
}

// Generated cases: every SDK's results are present for the current cases file,
// and every failing (kind) is a finding's, as `cases-<sdk>:<kind>:all` or
// `cases-<sdk>:<kind>:<type>`.
{
  const total = gunzipSync(readFileSync(join(CORPUS, 'generated', 'cases.jsonl.gz'))).toString().trim().split('\n').length;
  for (const sdk of ['rust', 'javascript', 'go', 'python', 'python-xdr', 'java', 'php', 'stellar-core']) {
    const file = `cases-${sdk}.json`;
    if (!existsSync(join(RESULTS, file))) {
      if (!runnersOnly) failures.push(`${file} missing`);
      continue;
    }
    const r = read(file);
    if (r.cases !== total) failures.push(`${file}: ran ${r.cases} cases, the cases file has ${total} (re-run it)`);
    for (const [kind, types] of Object.entries(r.failing_types ?? {})) {
      for (const [type, n] of Object.entries(types)) {
        if (!explained.has(`cases-${sdk}:${kind}:all`) && !explained.has(`cases-${sdk}:${kind}:${type}`)) failures.push(`cases ${sdk}: ${n} ${kind} case(s) of ${type} fail and no finding explains it`);
      }
    }
  }
  for (const key of explained.keys()) {
    const m = key.match(/^cases-([a-z-]+):([a-z_]+):/);
    if (m && existsSync(join(RESULTS, `cases-${m[1]}.json`)) && !read(`cases-${m[1]}.json`).failing_types?.[m[2]]) failures.push(`finding ${explained.get(key).id} claims ${key}, which passes`);
  }
}

// The RFP's sightings: every claim in corpus/sightings.json holds.
const sightingRows = runnersOnly ? [] : (() => {
  const { failures: f, rows } = checkSightings();
  failures.push(...f);
  return rows;
})();

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
const reproduced = findings.filter((f) => f.reproduced).length;
const sightingsReproduced = sightingRows.filter((r) => r.status === 'reproduced').length;
console.log(`all green: ${fixtures.length} fixtures; ${findings.length} findings, ${reproduced} reproduced; RFP sightings ${sightingsReproduced}/${sightingRows.length} reproduced`);
