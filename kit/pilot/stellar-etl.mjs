// Upstream pilot: stellar/stellar-etl over the corpus.
//
//  1. check out stellar-etl at a pinned release into .cache/stellar-etl
//  2. drop in kit/pilot/stellar-etl/adapter.go (needs the module's internal packages)
//  3. for each fixture with expected_indexed, the adapter reads its canonical
//     ledger from corpus/ledgers and runs the transforms stellar-etl's exports
//     run (transactions, operations, effects, signers, trustlines)
//  4. score the rows against expected_indexed (kit/pilot/score-etl.mjs)
//
// stellar-etl writes 64-bit integers as JSON numbers, so the output is parsed
// with a reviver that keeps each number's source text: nothing is rounded on
// our side.
//
//   node kit/pilot/stellar-etl.mjs   (writes corpus/results/pilot-stellar-etl.json)
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS, RESULTS, ROOT, readCorpus } from '../lib/fixture.mjs';
import { PASSPHRASE } from '../rpc/server.mjs';
import { scoreEtl } from './score-etl.mjs';

const REFS = JSON.parse(readFileSync(join(ROOT, 'kit', 'pilot', 'stellar-etl', 'refs.json'), 'utf8'));
const DIR = join(ROOT, '.cache', 'stellar-etl');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'], encoding: 'utf8', ...opts });

if (!existsSync(join(DIR, '.git'))) {
  mkdirSync(DIR, { recursive: true });
  sh('git', ['init', '-q'], { cwd: DIR });
  sh('git', ['remote', 'add', 'origin', REFS.repo], { cwd: DIR });
}
sh('git', ['fetch', '-q', '--depth', '1', 'origin', 'tag', REFS.ref], { cwd: DIR });
sh('git', ['checkout', '-q', '--force', REFS.ref], { cwd: DIR });
mkdirSync(join(DIR, 'istravex_pilot'), { recursive: true });
copyFileSync(join(ROOT, 'kit', 'pilot', 'stellar-etl', 'adapter.go'), join(DIR, 'istravex_pilot', 'main.go'));

const corpus = readCorpus().filter(({ manifest }) => manifest.expected_indexed && manifest.network !== 'synthetic');
const requests = corpus.map(({ manifest: m }) => ({
  fixture: m.id,
  ledger_file: join(CORPUS, 'ledgers', m.network, `${m.source.ledger}.xdr.zst`),
  passphrase: m.source.generator?.network_passphrase ?? PASSPHRASE[m.network],
  ledger: m.source.ledger,
  tx_hash: m.source.tx_hash,
}));

const text = await new Promise((resolve, reject) => {
  const child = spawn('go', ['run', '-tags', 'istravex_pilot', './istravex_pilot'], { cwd: DIR, env: { ...process.env, GOTOOLCHAIN: 'auto' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const out = [];
  child.stdout.on('data', (c) => out.push(c));
  child.on('error', reject);
  child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(`stellar-etl adapter exited ${code}`))));
  child.stdin.end(JSON.stringify(requests));
});
// Keep every number's source text (to_muxed_id can be 2^64 - 1).
const raw = JSON.parse(text, (_k, v, ctx) => (typeof v === 'number' && !Number.isSafeInteger(v) ? ctx.source : v));
const results = corpus.map(({ manifest }, i) => scoreEtl(manifest, raw[i]));

writeFileSync(
  join(RESULTS, 'pilot-stellar-etl.json'),
  JSON.stringify(
    {
      component: 'stellar/stellar-etl',
      repo: REFS.repo,
      ref: REFS.ref,
      entrypoint: 'internal/transform: TransformTransaction, TransformOperation, TransformEffect, TransformSigners, TransformTrustline',
      runtime: sh('go', ['env', 'GOVERSION'], { cwd: DIR, env: { ...process.env, GOTOOLCHAIN: 'auto' } }).trim(),
      results,
      raw,
    },
    null,
    2,
  ) + '\n',
);
for (const r of results) console.log(r.fixture.padEnd(42), r.verdict.padEnd(10), r.checks.filter((c) => !c.ok).map((c) => `${c.field}: expected ${c.expected}, got ${c.observed}`).join('; '));
