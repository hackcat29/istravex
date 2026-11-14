// Run the JavaScript conformance checks across @stellar/stellar-sdk releases
// (kit/runners/js/versions.json plus the project's pin) and write the
// divergence matrix to corpus/results/javascript-matrix.json.
//
// Each release is installed once into .cache/sdk-js/<version>.
//   node kit/runners/js/matrix.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS, ROOT } from '../../lib/fixture.mjs';
import { conformance, loadSdk } from './run.mjs';

const spec = JSON.parse(readFileSync(join(ROOT, 'kit', 'runners', 'js', 'versions.json'), 'utf8'));
const rows = [];
for (const { version, role } of spec.versions) {
  const dir = join(ROOT, '.cache', 'sdk-js', version);
  if (!existsSync(join(dir, 'node_modules', '@stellar', 'stellar-sdk'))) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"private":true}\n');
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent', `${spec.package}@${version}`], { cwd: dir, stdio: 'inherit' });
  }
  const { sdk, version: got } = await loadSdk(dir);
  if (got !== version) throw new Error(`.cache/sdk-js/${version} holds ${got}`);
  rows.push({ version, role, ...pick(conformance(sdk, version)) });
}
const { sdk, version } = await loadSdk(ROOT);
rows.push({ version, role: 'current (package.json pin)', ...pick(conformance(sdk, version)) });

function pick(out) {
  return { runtime: out.runtime, results: out.results.map(({ fixture, checks, failed }) => ({ fixture, checks, failed })) };
}

writeFileSync(join(RESULTS, 'javascript-matrix.json'), JSON.stringify({ sdk: 'javascript', package: spec.package, versions: rows }, null, 2) + '\n');
for (const r of rows) {
  const bad = r.results.filter((x) => x.failed.length || Object.values(x.checks).includes('fail'));
  console.log(`${r.version.padEnd(8)} ${bad.length ? bad.map((x) => `${x.fixture}[${x.failed.join(',')}]`).join(' ') : 'all pass'}`);
}
