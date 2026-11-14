// Check the JavaScript SDK against stellar-core's golden LedgerCloseMeta, and
// index which golden tests exhibit each corpus pattern.
//
// Goldens are stream-framed LedgerCloseMeta files captured by core's own test
// suite (`--capture-lcm`, rng seed 12345, passphrase "(V) (;,,;) (V)",
// diagnostic events zeroed), one directory per test file, with index.json
// mapping file hashes to test names.
//
// Writes corpus/results/goldens-javascript.json and corpus/results/goldens-patterns.json.
//   node kit/goldens/check.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { xdr } from '@stellar/stellar-sdk';
import { RESULTS, ROOT } from '../lib/fixture.mjs';
import { COMMIT, fetchGoldens } from './fetch.mjs';

/** Split an XDR record-marked stream into frames. */
export function frames(buf) {
  const out = [];
  for (let off = 0; off + 4 <= buf.length; ) {
    const len = buf.readUInt32BE(off) & 0x7fffffff;
    out.push(buf.subarray(off + 4, off + 4 + len));
    off += 4 + len;
  }
  return out;
}

// What each corpus CAP looks like in a ledger, as XDR-JSON patterns.
const PATTERNS = {
  'CAP-0015': { label: 'fee-bump transaction', test: (j) => j.includes('"tx_fee_bump"') },
  'CAP-0027': { label: 'muxed account (M-address)', test: (j) => /"M[A-Z2-7]{68}"/.test(j) },
  'CAP-0040': { label: 'ed25519 signed-payload signer (P-address)', test: (j) => /"P[A-Z2-7]{60,}"/.test(j) },
  'CAP-0073': {
    label: 'SAC trust() creating a trustline',
    test: (j) => j.includes('"function_name":"trust"') && /"created":\{[^}]*"data":\{"trustline"/.test(j),
  },
};

const version = JSON.parse(readFileSync(join(ROOT, 'node_modules/@stellar/stellar-sdk/package.json'), 'utf8')).version;
const dir = fetchGoldens();
const result = { sdk: 'javascript', package: '@stellar/stellar-sdk', version, core_commit: COMMIT, files: 0, frames: 0, exact: 0, failures: [] };
const matches = Object.fromEntries(Object.keys(PATTERNS).map((c) => [c, []]));

for (const suite of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
  const index = JSON.parse(readFileSync(join(dir, suite, 'index.json'), 'utf8'));
  for (const file of readdirSync(join(dir, suite)).filter((f) => f.endsWith('.xdr')).sort()) {
    result.files++;
    const hash = file.replace(/\.xdr$/, '');
    const test = index[hash] ?? '(not in index)';
    const hit = new Set();
    for (const [i, raw] of frames(readFileSync(join(dir, suite, file))).entries()) {
      result.frames++;
      try {
        const lcm = xdr.LedgerCloseMeta.fromXDR(raw);
        if (Buffer.from(lcm.toXDR()).equals(raw)) result.exact++;
        else result.failures.push({ file: `${suite}/${file}`, frame: i, error: 're-encode differs' });
        const json = JSON.stringify(lcm);
        for (const [cap, p] of Object.entries(PATTERNS)) if (!hit.has(cap) && p.test(json)) hit.add(cap);
      } catch (err) {
        result.failures.push({ file: `${suite}/${file}`, frame: i, error: String(err.message ?? err).slice(0, 200) });
      }
    }
    for (const cap of hit) matches[cap].push({ suite, file, test });
  }
}

writeFileSync(join(RESULTS, 'goldens-javascript.json'), JSON.stringify(result, null, 2) + '\n');
const patterns = {
  core_commit: COMMIT,
  source: 'stellar-core test-lcm-current (checked by `stellar-core test --check-lcm`)',
  caps: Object.fromEntries(
    Object.entries(PATTERNS).map(([cap, p]) => [cap, { pattern: p.label, golden_files: matches[cap].length, tests: [...new Set(matches[cap].map((m) => `${m.suite}: ${m.test}`))].slice(0, 25) }]),
  ),
};
writeFileSync(join(RESULTS, 'goldens-patterns.json'), JSON.stringify(patterns, null, 2) + '\n');
console.log(`javascript: ${result.exact}/${result.frames} frames exact in ${result.files} files, ${result.failures.length} failures`);
for (const [cap, c] of Object.entries(patterns.caps)) console.log(`${cap} ${c.pattern}: ${c.golden_files} golden files`);
