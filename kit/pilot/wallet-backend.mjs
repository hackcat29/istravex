// Upstream pilot: run stellar/wallet-backend's ingestion over the corpus.
//
//  1. check out wallet-backend at a pinned commit into .cache/
//  2. drop in kit/pilot/wallet-backend/adapter.go (needs the module's internal packages)
//  3. serve corpus/ledgers through the mock RPC (one server per network)
//  4. wallet-backend's own RPC ledger backend fetches each fixture ledger,
//     indexer.ProcessLedger indexes it, and the adapter prints the result
//  5. score the output against each fixture's expected_indexed
//  6. run istravex-lint (IX001–IX003) over the same checkout and attach the
//     reviewed triage from kit/pilot/wallet-backend/triage.json
//
// Then the sightings (kit/pilot/wallet-backend/refs.json): for each upstream
// bug, run the fixtures that reproduce it on the commit before the fix and on
// the fix itself. The harness reproduces the bug when the "before" run isn't
// all correct and the "after" run is; lint runs on both commits too.
//
//   node kit/pilot/wallet-backend.mjs            (writes corpus/results/pilot-wallet-backend.json)
//   node kit/pilot/wallet-backend.mjs --raw      (print the current commit's adapter output only)
//   node kit/pilot/wallet-backend.mjs --current  (skip the sightings)
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS, ROOT, readCorpus } from '../lib/fixture.mjs';
import { PASSPHRASE, startServer } from '../rpc/server.mjs';
import { score } from './score.mjs';
import { exportLake, startLakeServer } from '../datalake/lake.mjs';

const REFS = JSON.parse(readFileSync(join(ROOT, 'kit', 'pilot', 'wallet-backend', 'refs.json'), 'utf8'));
export const REPO = REFS.repo;
export const REF = REFS.current.ref;
const DIR = join(ROOT, '.cache', 'wallet-backend');

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'], encoding: 'utf8', ...opts });

/** Run a command without blocking the event loop (the mock RPC lives in this process). */
function run(cmd, args, { cwd, input, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'inherit'] });
    const out = [];
    child.stdout.on('data', (c) => out.push(c));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(`${cmd} exited ${code}`))));
    child.stdin.end(input);
  });
}

/**
 * The adapter, adjusted to the checkout's internal API. Between the sighting
 * commits and main, NewIndexer gained a parameter, ProcessLedger briefly
 * returned the ledger's transactions, and state changes' signer column
 * changed type when signed-payload signers were added (#729).
 */
function adapterFor(dir) {
  let src = readFileSync(join(ROOT, 'kit', 'pilot', 'wallet-backend', 'adapter.go'), 'utf8');
  const indexer = readFileSync(join(dir, 'internal', 'indexer', 'indexer.go'), 'utf8');
  const types = readFileSync(join(dir, 'internal', 'indexer', 'types', 'types.go'), 'utf8');
  if (!/func NewIndexer\([^)]*collectContractData bool\)/.test(indexer)) {
    src = src.replace('indexer.NewIndexer(req.Passphrase, pool, m.Ingestion, false)', 'indexer.NewIndexer(req.Passphrase, pool, m.Ingestion)');
  }
  if (/func ProcessLedger\([^)]*\) \(int, \[\]ingest\.LedgerTransaction, error\)/.test(indexer)) {
    src = src.replace('if _, err := indexer.ProcessLedger(', 'if _, _, err := indexer.ProcessLedger(');
  }
  if (!/type SignerKeyBytea /.test(types)) {
    src = src.replace('string(sc.SignerAccountID.SignerKeyBytea)', 'string(sc.SignerAccountID.AddressBytea)');
  }
  return src;
}

function checkout(ref) {
  if (!existsSync(join(DIR, '.git'))) {
    mkdirSync(DIR, { recursive: true });
    sh('git', ['init', '-q'], { cwd: DIR });
    sh('git', ['remote', 'add', 'origin', REPO], { cwd: DIR });
  }
  const head = existsSync(join(DIR, 'go.mod')) ? sh('git', ['rev-parse', 'HEAD'], { cwd: DIR }).trim() : '';
  if (head !== ref) {
    sh('git', ['fetch', '-q', '--depth', '1', 'origin', ref], { cwd: DIR });
    sh('git', ['checkout', '-q', '--force', ref], { cwd: DIR });
  }
  mkdirSync(join(DIR, 'istravex_pilot'), { recursive: true });
  writeFileSync(join(DIR, 'istravex_pilot', 'main.go'), adapterFor(DIR));
}

// Fixtures with hand-written expected_indexed, and every transaction fixture
// chosen by set cover (pattern tx), scored against Horizon's values.
const indexable = (dir) => readCorpus(dir).filter(({ manifest }) => (manifest.expected_indexed || manifest.pattern === 'tx') && manifest.network !== 'synthetic');
const corpus = indexable();
const servers = {};
for (const network of new Set(corpus.map((c) => c.manifest.network))) servers[network] = await startServer({ network });

/**
 * Index the given fixtures at `ref`; returns [raw adapter output, scored results].
 * With `lake` ({ endpoint, bucket }), ledgers come from the data lake through
 * wallet-backend's S3 datastore backend instead of the mock RPC.
 */
async function pilot(ref, fixtures = corpus, serve = servers, lake) {
  checkout(ref);
  const requests = fixtures.map(({ manifest: m }) => ({
    fixture: m.id,
    rpc_url: serve ? `http://127.0.0.1:${serve[m.network].address().port}` : '',
    passphrase: PASSPHRASE[m.network],
    ledger: m.source.ledger,
    tx_hash: m.source.tx_hash,
    ...(lake && { bucket_path: `${lake.bucket}/${m.network}`, endpoint_url: lake.endpoint }),
  }));
  // Safe to parse: the adapter emits every 64-bit integer as a string.
  // The S3 client signs requests, so it needs some credentials; the lake ignores them.
  const env = { ...process.env, AWS_ACCESS_KEY_ID: 'istravex', AWS_SECRET_ACCESS_KEY: 'istravex', AWS_REGION: 'us-east-1' };
  const raw = JSON.parse(await run('go', ['run', '-tags', 'istravex_pilot', './istravex_pilot'], { cwd: DIR, input: JSON.stringify(requests), env }));
  return [raw, fixtures.map(({ manifest }, i) => score(manifest, raw[i]))];
}

// istravex-lint over the checkout. Test variants report the same position twice; dedupe.
const bin = join(ROOT, '.cache', 'bin', 'istravex-lint');
sh('go', ['build', '-o', bin, './cmd/istravex-lint'], { cwd: join(ROOT, 'kit', 'go') });
async function lint(ref, triage = {}) {
  const lintJson = JSON.parse(await run(bin, ['-json', '-test=false', './...'], { cwd: DIR, input: '' }));
  const seen = new Set();
  const findings = [];
  for (const analyzers of Object.values(lintJson)) {
    for (const [rule, items] of Object.entries(analyzers)) {
      if (!Array.isArray(items)) continue;
      for (const it of items) {
        const [file, line] = it.posn.slice(DIR.length + 1).split(':');
        const key = `${rule} ${file}:${line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const t = triage[`${rule} ${file}`] ?? { status: 'untriaged', note: '' };
        // Keep the source lines with the finding, so reports need no checkout.
        const src = readFileSync(join(DIR, file), 'utf8').split('\n');
        const from = Math.max(0, Number(line) - 5);
        const snippet = { from: from + 1, lines: src.slice(from, Number(line) + 3) };
        findings.push({ rule, file, line: Number(line), message: it.message, ...t, url: `${REPO}/blob/${ref}/${file}#L${line}`, snippet });
      }
    }
  }
  return findings.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.line - b.line);
}

let current, raw, results, findings, datastoreResults;
try {
  [raw, results] = await pilot(REF);
  if (process.argv.includes('--raw')) {
    process.stdout.write(JSON.stringify(raw, null, 2) + '\n');
    process.exit(0);
  }
  const triage = JSON.parse(readFileSync(join(ROOT, 'kit', 'pilot', 'wallet-backend', 'triage.json'), 'utf8'));
  findings = await lint(REF, triage);

  // The same fixtures again, through the data lake: export the corpus in the
  // Galexie layout, serve it as S3, and use wallet-backend's datastore backend.
  const lakeRoot = join(ROOT, '.cache', 'lake');
  exportLake(join(lakeRoot, 'istravex'));
  const lakeServer = await startLakeServer({ root: lakeRoot });
  try {
    [, datastoreResults] = await pilot(REF, corpus, null, { endpoint: `http://127.0.0.1:${lakeServer.address().port}`, bucket: 'istravex' });
  } finally {
    lakeServer.close();
  }
  for (const r of datastoreResults) console.log(`datastore ${r.fixture.padEnd(42)} ${r.verdict}`);
  current = true;

  var sightings = [];
  if (!process.argv.includes('--current')) {
    // The pre-fix commits predate protocol 29: replay a protocol 28 corpus (refs.json, sightings_corpus).
    const sc = REFS.sightings_corpus;
    const scDir = join(ROOT, sc.dir);
    if (!existsSync(join(scDir, 'fixtures'))) {
      console.log(`generating the protocol ${sc.protocol} sightings corpus in ${sc.dir}`);
      sh('node', [join(ROOT, 'kit', 'capture', 'generate.mjs'), '--protocol', String(sc.protocol), '--out', scDir], { stdio: ['ignore', 'ignore', 'inherit'] });
    }
    const scCorpus = indexable(scDir);
    const scServers = {};
    for (const network of new Set(scCorpus.map((c) => c.manifest.network))) scServers[network] = await startServer({ network, corpusDir: scDir });
    for (const s of REFS.sightings) {
      const fixtures = scCorpus.filter(({ manifest }) => s.fixtures.includes(manifest.id));
      if (fixtures.length !== s.fixtures.length) throw new Error(`${s.issue}: fixture missing from the sightings corpus`);
      for (const f of fixtures) if (f.manifest.protocol_version !== sc.protocol) throw new Error(`${f.manifest.id}: protocol ${f.manifest.protocol_version}, expected ${sc.protocol}`);
      // A lint-only sighting has no fixtures: just check out each commit for lint.
      const [, before] = fixtures.length ? await pilot(s.before, fixtures, scServers) : (checkout(s.before), [null, []]);
      const beforeLint = await lint(s.before);
      const [, after] = fixtures.length ? await pilot(s.fixed_by.ref, fixtures, scServers) : (checkout(s.fixed_by.ref), [null, []]);
      const afterLint = await lint(s.fixed_by.ref);
      const strip = (r) => ({ fixture: r.fixture, verdict: r.verdict, failed: r.checks.filter((c) => !c.ok).map((c) => `${c.field}: expected ${c.expected}, got ${c.observed}`) });
      // Replay reproduces it when the commit before the fix gets a fixture wrong and the fix gets every one right;
      // lint, when the expected rules fire before the fix and not after.
      const replayReproduced = fixtures.length ? before.some((r) => r.verdict !== 'correct') && after.every((r) => r.verdict === 'correct') : null;
      const rules = s.lint_rules ?? [];
      const lintReproduced = rules.length ? rules.every((r) => beforeLint.some((f) => f.rule === r) && !afterLint.some((f) => f.rule === r)) : null;
      const reproduced = [replayReproduced, lintReproduced].filter((x) => x !== null).every(Boolean);
      sightings.push({
        ...s,
        before: { ref: s.before, results: before.map(strip), lint: beforeLint.map(({ rule, file, line, message }) => ({ rule, file, line, message })) },
        after: { ref: s.fixed_by.ref, results: after.map(strip), lint: afterLint.map(({ rule, file, line, message }) => ({ rule, file, line, message })) },
        protocol: sc.protocol,
        replay_reproduced: replayReproduced,
        lint_reproduced: lintReproduced,
        reproduced,
      });
      if (s === REFS.sightings.at(-1)) for (const x of Object.values(scServers)) x.close();
      console.log(`${s.issue.padEnd(28)} before ${before.map((r) => r.verdict).join(',').padEnd(22)} after ${after.map((r) => r.verdict).join(',').padEnd(22)} ${reproduced ? 'REPRODUCED' : 'NOT reproduced'}`);
    }
  }
} finally {
  for (const s of Object.values(servers)) s.close();
}
if (!current) process.exit(1);

const goVersion = sh('go', ['env', 'GOVERSION']).trim();
const out = {
  component: 'stellar/wallet-backend',
  repo: REPO,
  ref: REF,
  entrypoint: 'internal/indexer.ProcessLedger via ingest.NewLedgerBackend(rpc)',
  runtime: goVersion,
  results,
  // The same fixtures through the data-lake input: ingest.NewLedgerBackend(datastore) over kit/datalake/lake.mjs.
  datastore: { entrypoint: 'internal/indexer.ProcessLedger via ingest.NewLedgerBackend(datastore, S3 endpoint_url)', results: datastoreResults.map(({ fixture, verdict }) => ({ fixture, verdict })) },
  lint: { tool: 'istravex-lint', rules: ['IX001', 'IX002', 'IX003'], findings },
  sightings,
  raw,
};
const path = join(RESULTS, 'pilot-wallet-backend.json');
// --current keeps the sightings from the last full run.
if (process.argv.includes('--current') && existsSync(path)) out.sightings = JSON.parse(readFileSync(path, 'utf8')).sightings ?? [];
writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
for (const r of results) console.log(r.fixture.padEnd(42), r.verdict.padEnd(10), r.checks.filter((c) => !c.ok).map((c) => `${c.field}: expected ${c.expected}, got ${c.observed}`).join('; '));
for (const f of findings) console.log(`${f.rule} ${f.file}:${f.line} [${f.status}]`);
