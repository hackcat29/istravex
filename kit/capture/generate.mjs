// Generate fixtures on a pinned stellar-core: a fresh standalone network,
// upgraded to PROTOCOL, driven over core's own HTTP interface. Ledgers come
// from core's METADATA_OUTPUT_STREAM. Same scenarios as testnet; the output is
// reproducible in structure and needs no external network.
//
// The binary is pinned by sha256. Install it with `brew install stellar-core`
// (Homebrew bottle 30.0.0, arm64_tahoe) or point STELLAR_CORE at an identical
// build; a different binary is refused unless --allow-unpinned is passed.
//   node kit/capture/generate.mjs
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/fixture.mjs';
import { coreDriver } from './drivers/core.mjs';
import { runScenarios } from './scenarios.mjs';

const binary = realpathSync(process.env.STELLAR_CORE ?? execFileSync('which', ['stellar-core'], { encoding: 'utf8' }).trim());
const sha = createHash('sha256').update(readFileSync(binary)).digest('hex');
const version = execFileSync(binary, ['version'], { encoding: 'utf8', stderr: 'ignore', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0].trim();
const pinned = JSON.parse(readFileSync(join(ROOT, 'kit', 'capture', 'core-pin.json'), 'utf8'));
if ((sha !== pinned.binary_sha256 || !version.startsWith(pinned.version)) && !process.argv.includes('--allow-unpinned')) {
  console.error(`stellar-core at ${binary} is ${version} (sha256 ${sha}); pinned ${pinned.version} (sha256 ${pinned.binary_sha256}).`);
  process.exit(1);
}

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
