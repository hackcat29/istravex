// Generate fixtures on a pinned stellar-core: a fresh standalone network,
// upgraded to PROTOCOL, driven over core's own HTTP interface. Ledgers come
// from core's METADATA_OUTPUT_STREAM. Same scenarios as testnet; the output is
// reproducible in structure and needs no external network.
//
// The binary is pinned by sha256 per platform (kit/capture/core-pin.json):
//   darwin-arm64  Homebrew bottle 30.0.0
//   linux-x64     SDF's apt.stellar.org package 30.0.0 (what CI uses)
// Point STELLAR_CORE at the binary if it is not on PATH. A binary that does
// not match its platform's pin is refused unless --allow-unpinned is passed.
//   node kit/capture/generate.mjs
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/fixture.mjs';
import { coreDriver } from './drivers/core.mjs';
import { runScenarios } from './scenarios.mjs';

const USAGE = `usage: node kit/capture/generate.mjs [--force] [--allow-unpinned]
  --force           replace the committed local fixtures (they are regenerated with new keys)
  --allow-unpinned  run with a stellar-core that does not match kit/capture/core-pin.json`;
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const existing = readdirSync(join(ROOT, 'corpus', 'fixtures')).filter((d) => d.endsWith('-local-0001'));
if (existing.length && !process.argv.includes('--force')) {
  console.error(`local fixtures already exist (${existing.join(', ')}); pass --force to regenerate them.\n${USAGE}`);
  process.exit(1);
}

const binary = realpathSync(process.env.STELLAR_CORE ?? execFileSync('which', ['stellar-core'], { encoding: 'utf8' }).trim());
const sha = createHash('sha256').update(readFileSync(binary)).digest('hex');
const version = execFileSync(binary, ['version'], { encoding: 'utf8', stderr: 'ignore', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0].trim();
const pin = JSON.parse(readFileSync(join(ROOT, 'kit', 'capture', 'core-pin.json'), 'utf8'));
const platform = `${process.platform}-${process.arch}`;
const build = pin.builds[platform];
// Builds print their version differently: Homebrew "v30.0.0-dirty", SDF's apt
// package "stellar-core 30.0.0 (0e49751…)". The binary hash is the real pin;
// the version is a sanity check on the bare number.
const bare = (v) => v.match(/v?(\d+\.\d+\.\d+)/)?.[1];
const pinnedOk = build && sha === build.binary_sha256 && bare(version) === bare(pin.version);
if (!pinnedOk && !process.argv.includes('--allow-unpinned')) {
  console.error(
    build
      ? `stellar-core at ${binary} is ${version} (sha256 ${sha}); ${platform} pin is ${pin.version} (sha256 ${build.binary_sha256}). Install: ${build.install}`
      : `no pinned stellar-core build for ${platform}; pinned platforms: ${Object.keys(pin.builds).join(', ')}`,
  );
  process.exit(1);
}
const pinned = { protocol: pin.protocol, build: build?.source ?? 'unpinned' };

const d = await coreDriver({
  workdir: join(ROOT, '.cache', 'core-standalone'),
  binary,
  protocol: pinned.protocol,
  generator: { core_version: version, build: pinned.build, binary_sha256: sha, protocol_version: pinned.protocol, soroban_limits_factor: 10 },
});
// Report the scenario's own error; keep the work directory (core.log) on failure.
let failure;
try {
  await runScenarios(d);
} catch (err) {
  failure = err;
}
await d.close({ keep: Boolean(failure) });
if (failure) {
  console.error(failure);
  process.exit(1);
}
