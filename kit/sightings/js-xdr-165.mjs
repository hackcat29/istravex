// RFP sighting stellar/js-xdr#165: Writer primitive methods silently coerce
// invalid inputs instead of throwing.
//
// Runs the issue's cases against a build of @stellar/js-xdr and reports, per
// case, whether the writer threw (the fix) or wrote something (the bug).
//
//   node kit/sightings/js-xdr-165.mjs <path to a js-xdr ESM or CJS entry> [label]
//
// .github/workflows/sightings.yml runs it on the 5.0.0 release (before the
// fix, latest release) and on the merged fix (stellar/js-xdr#173, 96862ad),
// and writes corpus/results/sightings-js-xdr-165.json.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [entry, label = entry] = process.argv.slice(2);
if (!entry) {
  console.error('usage: node kit/sightings/js-xdr-165.mjs <js-xdr entry> [label]');
  process.exit(2);
}
const path = resolve(entry);
const xdr = path.endsWith('.cjs') ? createRequire(import.meta.url)(path) : await import(pathToFileURL(path).href);
const { Writer } = xdr.default?.Writer ? xdr.default : xdr;

const bytes = (w) => Buffer.from(w.finalize ? w.finalize() : w.toUint8Array()).toString('hex');
const cases = [
  ['writeUint32(2^32)', (w) => w.writeUint32(2 ** 32)],
  ['writeUint32(-1)', (w) => w.writeUint32(-1)],
  ['writeInt32(1000.75)', (w) => w.writeInt32(1000.75)],
  ['writeUint32(NaN)', (w) => w.writeUint32(NaN)],
  ['writeInt32(2^31)', (w) => w.writeInt32(2 ** 31)],
  ['writePadding(1.5)', (w) => w.writePadding(1.5)],
  ['writeBytes({ length: -4 })', (w) => (w.writeUint32(0xaaaaaaaa), w.writeBytes({ length: -4 }))],
];
const results = cases.map(([name, fn]) => {
  const w = new Writer();
  try {
    fn(w);
    let out;
    try {
      out = bytes(w);
    } catch (err) {
      out = `unreadable (${err.message})`;
    }
    return { case: name, outcome: 'accepted', wrote: out };
  } catch (err) {
    return { case: name, outcome: 'threw', error: String(err.message).slice(0, 120) };
  }
});
console.log(JSON.stringify({ sighting: 'stellar/js-xdr#165', build: label, all_rejected: results.every((r) => r.outcome === 'threw'), results }, null, 2));
