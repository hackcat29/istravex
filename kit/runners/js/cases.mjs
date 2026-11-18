// Generated cases through @stellar/stellar-sdk: every valid case must decode
// and re-encode byte for byte; every hostile one (trailing bytes, truncation,
// an unknown discriminant) must be refused. Types the SDK doesn't expose are
// counted as unsupported, not as failures.
//
//   node kit/runners/js/cases.mjs [cases.jsonl.gz]   → corpus/results/cases-javascript.json
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { CORPUS, RESULTS, ROOT } from '../../lib/fixture.mjs';
import { summarize } from '../../lib/cases.mjs';
import { loadSdk } from './run.mjs';

const path = process.argv[2] ?? join(CORPUS, 'generated', 'cases.jsonl.gz');
const cases = gunzipSync(readFileSync(path)).toString().trim().split('\n').map((l) => JSON.parse(l));
const { sdk, version } = await loadSdk(ROOT);
const byName = new Map(Object.keys(sdk.xdr).map((k) => [k.toLowerCase(), sdk.xdr[k]]));

const results = cases.map((c) => {
  const codec = byName.get(c.type.toLowerCase());
  if (!codec?.fromXDR) return { ...c, outcome: 'unsupported' };
  let value;
  try {
    value = codec.fromXDR(c.b64, 'base64');
  } catch {
    return { ...c, outcome: c.kind === 'valid' ? 'fail' : 'pass' };
  }
  if (c.kind !== 'valid') return { ...c, outcome: 'fail' };
  try {
    const again = typeof value?.toXDR === 'function' ? value.toXDR('base64') : Buffer.from(codec.toXDR(value)).toString('base64');
    return { ...c, outcome: again === c.b64 ? 'pass' : 'fail' };
  } catch {
    return { ...c, outcome: 'fail' };
  }
});
const out = { sdk: 'javascript', package: '@stellar/stellar-sdk', version, ...summarize(results) };
writeFileSync(join(RESULTS, 'cases-javascript.json'), JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify({ ...out, failures: out.failures.length, by_kind_and_type: undefined }));
