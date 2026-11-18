// Shared helpers for writing corpus fixtures.
// Layout: corpus/fixtures/<id>/manifest.json + one <name>.xdr.b64 per XDR value.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The corpus directory. ISTRAVEX_CORPUS points tools at another copy (e.g. a regenerated one). */
export const CORPUS = process.env.ISTRAVEX_CORPUS ? resolve(process.env.ISTRAVEX_CORPUS) : join(ROOT, 'corpus');
export const FIXTURES = join(CORPUS, 'fixtures');
export const RESULTS = join(CORPUS, 'results');

export const sha256 = (b64) => createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');

/** `cap27-muxed-payment-pubnet-0001` → `muxed-payment`. */
export const patternOf = (id) => id.match(/^(?:cap\d+|base)-(.+)-(?:pubnet|testnet|local|synthetic)-\d{4}$/)[1];

/**
 * @param {object} m manifest (see corpus/README.md). `files` maps name → { xdr_type, b64 }.
 *                   The first file is the primary value; its type/sha land on the top level.
 */
export function writeFixture(m) {
  const dir = join(FIXTURES, m.id);
  mkdirSync(dir, { recursive: true });
  const files = Object.entries(m.files).map(([name, f]) => {
    const path = `${name}.xdr.b64`;
    writeFileSync(join(dir, path), f.b64 + '\n');
    return { name, xdr_type: f.xdr_type, path, sha256: sha256(f.b64), bytes: Buffer.from(f.b64, 'base64').length, ...(f.expect && { expect: f.expect }) };
  });
  const [primary] = files;
  const manifest = {
    id: m.id,
    pattern: m.pattern ?? patternOf(m.id),
    cap_ids: m.cap_ids,
    protocol_version: m.protocol_version,
    network: m.network,
    xdr_type: primary.xdr_type,
    xdr_path: m.xdr_path,
    sha256: primary.sha256,
    source: m.source,
    synthetic: m.synthetic ?? false,
    ...(m.expected_decoded && { expected_decoded: m.expected_decoded }),
    ...(m.expected_indexed && { expected_indexed: m.expected_indexed }),
    ...(m.sightings && { sightings: m.sightings }),
    ...(m.covers && { covers: m.covers }),
    files,
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${m.id} (${files.map((f) => `${f.name}:${f.bytes}B`).join(', ')})`);
  return manifest;
}

export function readCorpus(corpusDir = CORPUS) {
  const fixtures = join(corpusDir, 'fixtures');
  return readdirSync(fixtures, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = join(fixtures, d.name);
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
      const blobs = Object.fromEntries(
        manifest.files.map((f) => [f.name, readFileSync(join(dir, f.path), 'utf8').trim()]),
      );
      return { manifest, blobs };
    })
    .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}
