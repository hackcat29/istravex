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
//   node kit/pilot/wallet-backend.mjs            (writes corpus/results/pilot-wallet-backend.json)
//   node kit/pilot/wallet-backend.mjs --raw      (print adapter output only)
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS, ROOT, readCorpus } from '../lib/fixture.mjs';
import { PASSPHRASE, startServer } from '../rpc/server.mjs';
import { score } from './score.mjs';

export const REPO = 'https://github.com/stellar/wallet-backend';
export const REF = '3e22515a44979fdc3a558fda3991ca2b48e38cef'; // main @ 2026-11-12
const DIR = join(ROOT, '.cache', 'wallet-backend');

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'], encoding: 'utf8', ...opts });

/** Run a command without blocking the event loop (the mock RPC lives in this process). */
function run(cmd, args, { cwd, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
    const out = [];
    child.stdout.on('data', (c) => out.push(c));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(`${cmd} exited ${code}`))));
    child.stdin.end(input);
  });
}

function checkout() {
  if (!existsSync(join(DIR, '.git'))) {
    mkdirSync(DIR, { recursive: true });
    sh('git', ['init', '-q'], { cwd: DIR });
    sh('git', ['remote', 'add', 'origin', REPO], { cwd: DIR });
  }
  const head = existsSync(join(DIR, 'go.mod')) ? sh('git', ['rev-parse', 'HEAD'], { cwd: DIR }).trim() : '';
  if (head !== REF) {
    sh('git', ['fetch', '-q', '--depth', '1', 'origin', REF], { cwd: DIR });
    sh('git', ['checkout', '-q', '--force', REF], { cwd: DIR });
  }
  mkdirSync(join(DIR, 'istravex_pilot'), { recursive: true });
  copyFileSync(join(ROOT, 'kit', 'pilot', 'wallet-backend', 'adapter.go'), join(DIR, 'istravex_pilot', 'main.go'));
}

checkout();
const corpus = readCorpus().filter(({ manifest }) => manifest.expected_indexed);
const servers = {};
for (const network of new Set(corpus.map((c) => c.manifest.network))) servers[network] = await startServer({ network });
const requests = corpus.map(({ manifest: m }) => ({
  fixture: m.id,
  rpc_url: `http://127.0.0.1:${servers[m.network].address().port}`,
  passphrase: PASSPHRASE[m.network],
  ledger: m.source.ledger,
  tx_hash: m.source.tx_hash,
}));
let text;
try {
  text = await run('go', ['run', '-tags', 'istravex_pilot', './istravex_pilot'], { cwd: DIR, input: JSON.stringify(requests) });
} finally {
  for (const s of Object.values(servers)) s.close();
}

if (process.argv.includes('--raw')) {
  process.stdout.write(text);
  process.exit(0);
}
// Safe to parse: the adapter emits every 64-bit integer as a string.
const raw = JSON.parse(text);
const goVersion = sh('go', ['env', 'GOVERSION']).trim();
const results = corpus.map(({ manifest }, i) => score(manifest, raw[i]));

// Lint the same checkout. Test variants report the same position twice; dedupe.
const bin = join(ROOT, '.cache', 'bin', 'istravex-lint');
sh('go', ['build', '-o', bin, './cmd/istravex-lint'], { cwd: join(ROOT, 'kit', 'go') });
const lintJson = JSON.parse(await run(bin, ['-json', './...'], { cwd: DIR, input: '' }));
const triage = JSON.parse(readFileSync(join(ROOT, 'kit', 'pilot', 'wallet-backend', 'triage.json'), 'utf8'));
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
      findings.push({ rule, file, line: Number(line), message: it.message, ...t, url: `${REPO}/blob/${REF}/${file}#L${line}`, snippet });
    }
  }
}
const lint = { tool: 'istravex-lint', rules: ['IX001', 'IX002', 'IX003'], findings };
writeFileSync(
  join(RESULTS, 'pilot-wallet-backend.json'),
  JSON.stringify({ component: 'stellar/wallet-backend', repo: REPO, ref: REF, entrypoint: 'internal/indexer.ProcessLedger via ingest.NewLedgerBackend(rpc)', runtime: goVersion, results, lint, raw }, null, 2) + '\n',
);
for (const r of results) console.log(r.fixture.padEnd(42), r.verdict.padEnd(10), r.checks.filter((c) => !c.ok).map((c) => `${c.field}: expected ${c.expected}, got ${c.observed}`).join('; '));
for (const f of findings) console.log(`${f.rule} ${f.file}:${f.line} [${f.status}]`);
