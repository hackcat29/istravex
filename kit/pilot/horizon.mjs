// Upstream pilot: stellar/stellar-horizon over the corpus.
//
//  1. check out stellar-horizon at a pinned release into .cache/stellar-horizon
//     and build the horizon binary
//  2. export the corpus in the Galexie data-lake layout and serve it over the
//     kit's read-only S3 endpoint (kit/datalake/lake.mjs)
//  3. for each network, a fresh PostgreSQL database (`horizon db migrate up`),
//     then every fixture ledger through Horizon's own backfill command,
//     `horizon db reingest range <seq> <seq> --ledgerbackend datastore`
//  4. read back what Horizon stored (history_transactions, history_operations,
//     history_effects, participants) and score it against each fixture's
//     expected values (kit/pilot/score-horizon.mjs)
//
// Needs PostgreSQL: createdb/dropdb/psql on PATH, and a server the current
// user can create databases on (PGHOST etc. are honoured).
//
//   node kit/pilot/horizon.mjs   (writes corpus/results/pilot-horizon.json)
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS, RESULTS, ROOT, readCorpus } from '../lib/fixture.mjs';
import { scoreHorizon } from './score-horizon.mjs';

const REFS = JSON.parse(readFileSync(join(ROOT, 'kit', 'pilot', 'horizon', 'refs.json'), 'utf8'));
const DIR = join(ROOT, '.cache', 'stellar-horizon');
const BIN = join(ROOT, '.cache', 'bin', 'horizon');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 256 << 20, ...opts });

// 1. Horizon at the pinned release.
if (!existsSync(join(DIR, '.git'))) {
  mkdirSync(DIR, { recursive: true });
  sh('git', ['init', '-q'], { cwd: DIR });
  sh('git', ['remote', 'add', 'origin', REFS.repo], { cwd: DIR });
}
sh('git', ['-c', 'http.version=HTTP/1.1', 'fetch', '-q', '--depth', '1', 'origin', 'tag', REFS.ref], { cwd: DIR });
sh('git', ['checkout', '-q', '--force', REFS.ref], { cwd: DIR });
mkdirSync(join(ROOT, '.cache', 'bin'), { recursive: true });
sh('go', ['build', '-o', BIN, '.'], { cwd: DIR, env: { ...process.env, GOTOOLCHAIN: 'auto' } });

// 2. The corpus as a data lake, over S3.
const lakeRoot = join(ROOT, '.cache', 'lake');
sh('node', [join(ROOT, 'kit', 'datalake', 'lake.mjs'), 'export', '--out', join(lakeRoot, 'istravex')]);
const port = 9000 + Math.floor(Math.random() * 900);
const lake = spawn('node', [join(ROOT, 'kit', 'datalake', 'lake.mjs'), 'serve', '--root', lakeRoot, '--port', String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));

const PASSPHRASE = {
  pubnet: 'Public Global Stellar Network ; September 2015',
  testnet: 'Test SDF Network ; September 2015',
  local: 'Standalone Network ; February 2017',
};
const corpus = readCorpus().filter(({ manifest: m }) => m.network !== 'synthetic' && (m.expected_indexed || m.pattern === 'tx'));
const env = { ...process.env, AWS_ACCESS_KEY_ID: 'istravex', AWS_SECRET_ACCESS_KEY: 'istravex', AWS_REGION: 'us-east-1' };
const query = (db, sql) => {
  const out = sh('psql', ['-d', db, '-AtX', '-c', `select coalesce(json_agg(t), '[]') from (${sql}) t`]).trim();
  // Integers past 2^53 (muxed IDs, amounts in jsonb details) as strings, so
  // JSON.parse doesn't round them.
  return JSON.parse((out || '[]').replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
};

const raw = {};
const errors = {};
try {
  for (const network of ['pubnet', 'testnet', 'local']) {
    const fixtures = corpus.filter(({ manifest: m }) => m.network === network);
    if (!fixtures.length) continue;
    const db = `istravex_horizon_${network}`;
    sh('dropdb', ['--if-exists', db]);
    sh('createdb', [db]);
    const { PGHOST, PGPORT = '5432', PGUSER, PGPASSWORD } = process.env;
    const dbUrl = PGHOST
      ? `postgres://${encodeURIComponent(PGUSER ?? '')}${PGPASSWORD ? `:${encodeURIComponent(PGPASSWORD)}` : ''}@${PGHOST}:${PGPORT}/${db}?sslmode=disable`
      : `postgres:///${db}?sslmode=disable`;
    sh(BIN, ['db', 'migrate', 'up', '--db-url', dbUrl], { env });
    const config = join(ROOT, '.cache', `horizon-datastore-${network}.toml`);
    writeFileSync(
      config,
      `[buffered_storage_backend_config]\nbuffer_size = 1\nnum_workers = 1\nretry_limit = 2\nretry_wait = "1s"\n\n[datastore_config]\ntype = "S3"\n\n[datastore_config.params]\ndestination_bucket_path = "istravex/${network}"\nregion = "us-east-1"\nendpoint_url = "http://127.0.0.1:${port}"\n\n[datastore_config.schema]\nledgers_per_file = 1\nfiles_per_partition = 64000\n`,
    );
    const netArgs = network === 'local' ? ['--network-passphrase', PASSPHRASE.local, '--history-archive-urls', 'http://127.0.0.1:1/unused'] : ['--network', network];
    for (const seq of [...new Set(fixtures.map(({ manifest: m }) => m.source.ledger))].sort((a, b) => a - b)) {
      try {
        sh(BIN, ['db', 'reingest', 'range', String(seq), String(seq), '--db-url', dbUrl, ...netArgs, '--parallel-workers', '1', '--ledgerbackend', 'datastore', '--datastore-config', config], { env });
      } catch (err) {
        errors[`${network}/${seq}`] = String(err.stderr ?? err.message).split('\n').filter((l) => /error|fatal|panic/i.test(l)).slice(-3).join(' | ').slice(0, 500);
      }
    }
    for (const { manifest: m } of fixtures) {
      const hash = m.source.tx_hash;
      const [tx] = query(db, `select id::text as id, transaction_hash, inner_transaction_hash, ledger_sequence, account, account_muxed, fee_account, fee_charged::text as fee_charged, max_fee::text as max_fee, new_max_fee::text as new_max_fee, successful, operation_count, memo_type from history_transactions where transaction_hash = '${hash}' or inner_transaction_hash = '${hash}'`);
      if (!tx) {
        raw[m.id] = { found: false, error: errors[`${network}/${m.source.ledger}`] ?? 'transaction not stored' };
        continue;
      }
      raw[m.id] = {
        found: true,
        transaction: tx,
        operations: query(db, `select type, details, source_account, source_account_muxed from history_operations where transaction_id = ${tx.id}::bigint order by application_order`),
        effects: query(db, `select e.type, e.details, a.address, e.address_muxed from history_effects e join history_accounts a on a.id = e.history_account_id where e.history_operation_id > ${tx.id}::bigint and e.history_operation_id < ${tx.id}::bigint + 4096 order by e.history_operation_id, e."order"`),
        participants: query(db, `select a.address from history_transaction_participants p join history_accounts a on a.id = p.history_account_id where p.history_transaction_id = ${tx.id}::bigint`).map((r) => r.address),
      };
    }
  }
} finally {
  lake.kill();
}

const results = corpus.map(({ manifest }) => scoreHorizon(manifest, raw[manifest.id]));
writeFileSync(
  join(RESULTS, 'pilot-horizon.json'),
  JSON.stringify(
    {
      component: 'stellar/stellar-horizon',
      repo: REFS.repo,
      ref: REFS.ref,
      entrypoint: 'horizon db reingest range <seq> <seq> --ledgerbackend datastore, into PostgreSQL; history tables read back',
      runtime: sh('go', ['env', 'GOVERSION'], { cwd: DIR, env: { ...process.env, GOTOOLCHAIN: 'auto' } }).trim(),
      reingest_errors: errors,
      results,
      raw,
    },
    null,
    1,
  ) + '\n',
);
for (const r of results) console.log(r.fixture.padEnd(48), r.verdict.padEnd(10), r.checks.filter((c) => !c.ok).map((c) => `${c.field}: expected ${c.expected}, got ${c.observed}`).join('; '));
