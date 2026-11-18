// stellar-core as the oracle for generated cases.
//
// `stellar-core print-xdr` decodes six types. For every generated case of
// those types it records whether core accepts the bytes, so "valid" and
// "must be refused" are checked against the network's own decoder, not only
// against another library. Writes corpus/results/cases-stellar-core.json.
//
//   node kit/cases/core-oracle.mjs [stellar-core binary]
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { CORPUS, RESULTS } from '../lib/fixture.mjs';
import { summarize } from '../lib/cases.mjs';

const core = process.argv[2] ?? 'stellar-core';
// print-xdr --filetype → the XDR type it decodes.
const FILETYPE = {
  LedgerHeader: 'ledgerheader',
  TransactionMeta: 'meta',
  TransactionResult: 'result',
  TransactionResultPair: 'resultpair',
  TransactionEnvelope: 'tx',
  LedgerEntryChanges: 'txfee',
};
const version = execFileSync(core, ['version'], { encoding: 'utf8' }).split('\n')[0].trim();
const cases = gunzipSync(readFileSync(join(CORPUS, 'generated', 'cases.jsonl.gz'))).toString().trim().split('\n').map((l) => JSON.parse(l));
const dir = mkdtempSync(join(tmpdir(), 'istravex-core-'));
const file = join(dir, 'case.xdr');
// print-xdr exits 0 either way: it accepts when it prints the decoded value,
// and refuses with "Could not decode with type …" on stderr and nothing on stdout.
const accepts = (type, b64) => {
  writeFileSync(file, Buffer.from(b64, 'base64'));
  const r = spawnSync(core, ['print-xdr', file, '--filetype', FILETYPE[type]], { encoding: 'utf8', timeout: 20_000 });
  return r.status === 0 && r.stdout.trim().length > 0 && !/Could not decode/.test(r.stderr);
};
const results = cases.map((c) => {
  if (!FILETYPE[c.type]) return { ...c, outcome: 'unsupported' };
  const ok = accepts(c.type, c.b64);
  return { ...c, outcome: (c.kind === 'valid') === ok ? 'pass' : 'fail' };
});
rmSync(dir, { recursive: true, force: true });
const s = summarize(results);
// Unsupported here means "not one of print-xdr's types": report only those six.
s.unsupported_types = [];
const out = { sdk: 'stellar-core', package: 'stellar-core print-xdr', version, types: Object.keys(FILETYPE), ...s };
writeFileSync(join(RESULTS, 'cases-stellar-core.json'), JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify({ version, supported: s.supported, passed: s.passed, kinds: s.kinds, failing_types: s.failing_types }));
