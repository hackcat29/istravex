// Generate fixtures on a pinned stellar-core: a fresh standalone network,
// upgraded to PROTOCOL, driven over core's own HTTP interface. Ledgers come
// from core's METADATA_OUTPUT_STREAM. No external network, keys or funds.
//
// Reproducible: keys derive from --seed and ledgers close at fixed times, so
// the pinned binary regenerates every XDR byte. --check proves it against the
// committed corpus. Any network passphrase works: --passphrase testnet or
// pubnet builds the same scenarios as they would be signed for those networks.
//
// The binary is pinned by sha256 per platform (kit/capture/core-pin.json):
//   darwin-arm64  Homebrew bottle 30.0.0
//   linux-x64     SDF's apt.stellar.org package 30.0.0 (what CI uses)
// Point STELLAR_CORE at the binary if it is not on PATH.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { zstdDecompressSync } from 'node:zlib';
import { Networks } from '@stellar/stellar-sdk';

const USAGE = `usage: node kit/capture/generate.mjs [options]
  --force               replace the committed local fixtures
  --check               regenerate into a temporary corpus and compare every XDR byte with
                        the committed local fixtures and ledgers (with another --passphrase,
                        --seed or --protocol: with a second generation); exit 1 on any difference
  --out <dir>           write a corpus to <dir> instead of corpus/
  --passphrase <name>   standalone (default), testnet or pubnet; anything but standalone needs --out
  --seed <string>       key-derivation seed (default: istravex, the committed corpus)
  --protocol <n>        upgrade the network to protocol n instead of the pinned one (needs --out);
                        scenarios that need a later protocol are skipped
  --allow-unpinned      run with a stellar-core that does not match kit/capture/core-pin.json`;

const { values: opt } = parseArgs({
  options: {
    force: { type: 'boolean' },
    check: { type: 'boolean' },
    out: { type: 'string' },
    passphrase: { type: 'string', default: 'standalone' },
    seed: { type: 'string', default: 'istravex' },
    protocol: { type: 'string' },
    'allow-unpinned': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (opt.help) {
  console.log(USAGE);
  process.exit(0);
}
const PASSPHRASES = { standalone: 'Standalone Network ; February 2017', testnet: Networks.TESTNET, pubnet: Networks.PUBLIC };
const passphrase = PASSPHRASES[opt.passphrase];
if (!passphrase) {
  console.error(`unknown --passphrase ${opt.passphrase}\n${USAGE}`);
  process.exit(2);
}
const ROOT = resolve(import.meta.dirname, '..', '..');
const COMMITTED = join(ROOT, 'corpus');
let out = opt.out ? resolve(opt.out) : COMMITTED;
// What --check compares against: the committed corpus, or for any other
// passphrase, seed or protocol, a first generation made just now.
let baseline = COMMITTED;
if (opt.check) {
  out = mkdtempSync(join(tmpdir(), 'istravex-check-'));
  if (opt.passphrase !== 'standalone' || opt.protocol || opt.seed !== 'istravex') {
    baseline = mkdtempSync(join(tmpdir(), 'istravex-baseline-'));
    const args = [process.argv[1], '--out', baseline, '--passphrase', opt.passphrase, '--seed', opt.seed, ...(opt.protocol ? ['--protocol', opt.protocol] : []), ...(opt['allow-unpinned'] ? ['--allow-unpinned'] : [])];
    execFileSync(process.execPath, args, { stdio: ['ignore', 'ignore', 'inherit'] });
  }
}
if (out === COMMITTED && (opt.passphrase !== 'standalone' || opt.seed !== 'istravex' || opt.protocol)) {
  console.error('the committed corpus uses --passphrase standalone, --seed istravex and the pinned protocol; pass --out for anything else');
  process.exit(2);
}
// Every corpus helper reads ISTRAVEX_CORPUS when it is first imported.
process.env.ISTRAVEX_CORPUS = out;
const { coreDriver, CLOSE_TIME_BASE, CLOSE_TIME_STEP } = await import('./drivers/core.mjs');
const { runScenarios, PROBE_WASM } = await import('./scenarios.mjs');
const { sameUpToChangeOrder } = await import('../lib/canonical.mjs');

// A corpus written elsewhere gets the schema and an empty results directory,
// so the verifier and runners work on it as on the committed one.
if (out !== COMMITTED) {
  mkdirSync(join(out, 'results'), { recursive: true });
  mkdirSync(join(out, 'ledgers'), { recursive: true });
  copyFileSync(join(COMMITTED, 'manifest.schema.json'), join(out, 'manifest.schema.json'));
  if (!existsSync(join(out, 'ledgers', 'index.json'))) writeFileSync(join(out, 'ledgers', 'index.json'), '[]\n');
}

const localIds = (dir) => (existsSync(join(dir, 'fixtures')) ? readdirSync(join(dir, 'fixtures')).filter((d) => /-local-\d{4}$/.test(d)) : []);
if (out === COMMITTED) {
  const existing = localIds(COMMITTED);
  if (existing.length && !opt.force) {
    console.error(`local fixtures already exist (${existing.join(', ')}); pass --force to regenerate them.\n${USAGE}`);
    process.exit(1);
  }
  // Clear the old generated network: fixtures, ledgers and their index rows.
  for (const id of existing) rmSync(join(COMMITTED, 'fixtures', id), { recursive: true, force: true });
  rmSync(join(COMMITTED, 'ledgers', 'local'), { recursive: true, force: true });
  const indexPath = join(COMMITTED, 'ledgers', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8')).filter((e) => e.network !== 'local');
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
}

const binary = realpathSync(process.env.STELLAR_CORE ?? execFileSync('which', ['stellar-core'], { encoding: 'utf8' }).trim());
const sha = createHash('sha256').update(readFileSync(binary)).digest('hex');
const version = execFileSync(binary, ['version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0].trim();
const pin = JSON.parse(readFileSync(join(ROOT, 'kit', 'capture', 'core-pin.json'), 'utf8'));
const platform = `${process.platform}-${process.arch}`;
const build = pin.builds[platform];
// Builds print their version differently: Homebrew "v30.0.0-dirty", SDF's apt
// package "stellar-core 30.0.0 (0e49751…)". The binary hash is the real pin;
// the version is a sanity check on the bare number.
const bare = (v) => v.match(/v?(\d+\.\d+\.\d+)/)?.[1];
const pinnedOk = build && sha === build.binary_sha256 && bare(version) === bare(pin.version);
if (!pinnedOk && !opt['allow-unpinned']) {
  console.error(
    build
      ? `stellar-core at ${binary} is ${version} (sha256 ${sha}); ${platform} pin is ${pin.version} (sha256 ${build.binary_sha256}). Install: ${build.install}`
      : `no pinned stellar-core build for ${platform}; pinned platforms: ${Object.keys(pin.builds).join(', ')}`,
  );
  process.exit(1);
}

const protocol = opt.protocol ? Number(opt.protocol) : pin.protocol;
if (!(protocol >= 20 && protocol <= pin.protocol)) {
  console.error(`--protocol must be between 20 and ${pin.protocol}`);
  process.exit(2);
}
const d = await coreDriver({
  workdir: join(ROOT, '.cache', `core-standalone-${opt.passphrase}-${protocol}`),
  binary,
  protocol,
  passphrase,
  seed: opt.seed,
  generator: {
    core_version: version,
    build: build?.source ?? 'unpinned',
    binary_sha256: sha,
    protocol_version: protocol,
    soroban_limits_factor: 10,
    seed: opt.seed,
    network_passphrase: passphrase,
    close_time_base: CLOSE_TIME_BASE,
    close_time_step: CLOSE_TIME_STEP,
    probe_wasm_sha256: createHash('sha256').update(readFileSync(PROBE_WASM)).digest('hex'),
  },
});
// Report the scenario's own error; keep the work directory (core.log) on failure.
let failure;
try {
  await runScenarios(d, 'core');
} catch (err) {
  failure = err;
}
await d.close({ keep: Boolean(failure) });
if (failure) {
  console.error(failure);
  process.exit(1);
}

if (opt.check) {
  // Every XDR file of every local fixture and every local ledger. Consensus
  // data must match byte for byte; metadata may differ only in the order of
  // its LedgerEntryChange lists, which stellar-core 30.0.0 doesn't keep stable
  // between runs (kit/lib/canonical.mjs). Generator metadata (binary hash,
  // version string) differs between platforms by design and isn't compared.
  const diffs = [];
  let reordered = 0;
  // A LedgerEntryChanges file holds a bare change list; wrap it as OperationMeta (same bytes plus nothing).
  const wrap = (_f, raw) => raw;
  const fresh = localIds(out).sort();
  const committed = localIds(baseline).sort();
  if (fresh.join() !== committed.join()) diffs.push(`fixture ids differ:\n  regenerated ${fresh.join(', ')}\n  baseline    ${committed.join(', ')}`);
  for (const id of fresh.filter((x) => committed.includes(x))) {
    const a = JSON.parse(readFileSync(join(out, 'fixtures', id, 'manifest.json'), 'utf8'));
    const b = JSON.parse(readFileSync(join(baseline, 'fixtures', id, 'manifest.json'), 'utf8'));
    for (const f of a.files) {
      const g = b.files.find((x) => x.name === f.name);
      if (g?.sha256 === f.sha256) continue;
      const read = (dir) => Buffer.from(readFileSync(join(dir, 'fixtures', id, f.path), 'utf8').trim(), 'base64');
      if (g && /Meta|Changes/.test(f.xdr_type) && sameUpToChangeOrder(f.xdr_type === 'LedgerEntryChanges' ? 'OperationMeta' : f.xdr_type, wrap(f, read(out)), wrap(f, read(baseline)))) {
        reordered++;
        continue;
      }
      diffs.push(`${id}/${f.name}: ${f.sha256.slice(0, 12)} regenerated, ${g?.sha256.slice(0, 12) ?? 'missing'} committed`);
    }
    for (const k of ['expected_decoded', 'expected_indexed']) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffs.push(`${id}: ${k} differs`);
    }
  }
  const ledgers = (dir) =>
    Object.fromEntries(JSON.parse(readFileSync(join(dir, 'ledgers', 'index.json'), 'utf8')).filter((e) => e.network === 'local').map((e) => [e.ledger, e.sha256]));
  const la = ledgers(out);
  const lb = ledgers(baseline);
  const rawLedger = (dir, seq) => zstdDecompressSync(readFileSync(join(dir, 'ledgers', 'local', `${seq}.xdr.zst`)));
  for (const seq of new Set([...Object.keys(la), ...Object.keys(lb)])) {
    if (la[seq] === lb[seq]) continue;
    if (la[seq] && lb[seq] && sameUpToChangeOrder('LedgerCloseMetaBatch', rawLedger(out, seq), rawLedger(baseline, seq))) {
      reordered++;
      continue;
    }
    diffs.push(`ledger local/${seq}: ${la[seq]?.slice(0, 12) ?? 'missing'} regenerated, ${lb[seq]?.slice(0, 12) ?? 'missing'} committed`);
  }
  rmSync(out, { recursive: true, force: true });
  if (baseline !== COMMITTED) rmSync(baseline, { recursive: true, force: true });
  if (diffs.length) {
    console.error(`regeneration is NOT byte-identical (${diffs.length} differences):\n${diffs.join('\n')}`);
    process.exit(1);
  }
  console.log(
    `regeneration matches: ${fresh.length} fixtures, ${Object.keys(la).length} ledgers; consensus bytes identical` +
      (reordered ? `, ${reordered} file(s) differ only in metadata change order` : ', metadata byte-identical'),
  );
}
