// The corpus in the Galexie data-lake layout, the second way to feed it to an
// indexer (the first is the mock RPC's getLedgers).
//
//   export  write <out>/<network>/.config.json and one zstd LedgerCloseMetaBatch
//           per ledger at <partition>/<object>, exactly as SDF's public data lake
//           (aws-public-blockchain/v1.1/stellar/ledgers/pubnet) lays them out.
//           Pubnet objects are the data lake's own bytes. go-stellar-sdk's
//           Filesystem datastore reads the directory as is.
//   serve   a read-only, path-style S3 endpoint over an exported directory, for
//           ingestion that only speaks S3 (BufferedStorageBackend with
//           endpoint_url, e.g. stellar/wallet-backend's datastore backend).
//           GetObject, HeadObject and ListObjectsV2; credentials are ignored.
//
//   node kit/datalake/lake.mjs export --out .cache/lake/istravex [--network pubnet]
//   node kit/datalake/lake.mjs serve --root .cache/lake --port 9000
//     → bucket path istravex/pubnet, endpoint http://127.0.0.1:9000
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, relative, resolve, sep } from 'node:path';
import { crc32 } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CORPUS } from '../lib/fixture.mjs';
import { PASSPHRASE } from '../rpc/server.mjs';

export const LEDGERS_PER_BATCH = 1;
export const BATCHES_PER_PARTITION = 64000;
const rev = (n) => (0xffffffff - n).toString(16).toUpperCase().padStart(8, '0');

/** The object key of a ledger in the data-lake schema (one ledger per batch). */
export function objectKey(seq) {
  const start = Math.floor(seq / BATCHES_PER_PARTITION) * BATCHES_PER_PARTITION;
  return `${rev(start)}--${start}-${start + BATCHES_PER_PARTITION - 1}/${rev(seq)}--${seq}.xdr.zst`;
}

/** Export every ledger of the given networks (default: all) into <out>/<network>/. */
export function exportLake(out, { networks, corpusDir = CORPUS } = {}) {
  const index = JSON.parse(readFileSync(join(corpusDir, 'ledgers', 'index.json'), 'utf8'));
  const wanted = networks ?? [...new Set(index.map((e) => e.network))];
  const written = {};
  for (const network of wanted) {
    const dir = join(out, network);
    mkdirSync(dir, { recursive: true });
    const config = {
      networkPassphrase: PASSPHRASE[network],
      version: '1.0',
      compression: 'zstd',
      ledgersPerBatch: LEDGERS_PER_BATCH,
      batchesPerPartition: BATCHES_PER_PARTITION,
    };
    writeFileSync(join(dir, '.config.json'), JSON.stringify(config));
    const entries = index.filter((e) => e.network === network);
    for (const e of entries) {
      const key = objectKey(e.ledger);
      mkdirSync(join(dir, key.split('/')[0]), { recursive: true });
      writeFileSync(join(dir, key), readFileSync(join(corpusDir, e.path)));
    }
    written[network] = entries.length;
  }
  return written;
}

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    return d.isDirectory() ? walk(p, base) : [relative(base, p).split(sep).join('/')];
  });
}

/** A read-only path-style S3 endpoint: /<bucket>/<key>, where <root>/<bucket> is a directory. */
export function startLakeServer({ root, port = 0, host = '127.0.0.1' } = {}) {
  const base = resolve(root);
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://lake');
    const [bucket, ...rest] = decodeURIComponent(url.pathname).replace(/^\/+/, '').split('/');
    const bucketDir = join(base, bucket ?? '');
    const notFound = (code = 'NoSuchKey') => {
      res.writeHead(404, { 'content-type': 'application/xml' });
      res.end(req.method === 'HEAD' ? undefined : `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>not found</Message></Error>`);
    };
    if (!bucket || !existsSync(bucketDir) || bucketDir !== join(base, bucket) || !statSync(bucketDir).isDirectory()) return notFound('NoSuchBucket');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      return res.end();
    }
    const key = rest.join('/');
    if (!key) {
      // ListObjectsV2 (recursive, no delimiter support needed by the SDK).
      const prefix = url.searchParams.get('prefix') ?? '';
      const max = Math.min(Number(url.searchParams.get('max-keys') ?? 1000), 1000);
      const after = url.searchParams.get('start-after') ?? url.searchParams.get('continuation-token') ?? '';
      const all = walk(bucketDir).filter((k) => k.startsWith(prefix) && k > after).sort();
      const page = all.slice(0, max);
      const truncated = all.length > page.length;
      const contents = page
        .map((k) => {
          const st = statSync(join(bucketDir, k));
          return `<Contents><Key>${xml(k)}</Key><LastModified>${st.mtime.toISOString()}</LastModified><ETag>"${st.size}-${st.mtimeMs | 0}"</ETag><Size>${st.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
        })
        .join('');
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xml(bucket)}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${
          truncated ? `<NextContinuationToken>${xml(page.at(-1))}</NextContinuationToken>` : ''
        }${contents}</ListBucketResult>`,
      );
    }
    const file = join(bucketDir, key);
    if (!file.startsWith(bucketDir + sep) || !existsSync(file) || !statSync(file).isFile()) return notFound();
    const st = statSync(file);
    // S3 clients validate a CRC32 when the server sends one. Objects are small
    // (one ledger), so computing it per request is cheap.
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(readFileSync(file)));
    res.writeHead(200, {
      'content-type': key.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      'content-length': st.size,
      'x-amz-checksum-crc32': crc.toString('base64'),
      'x-amz-checksum-type': 'FULL_OBJECT',
      etag: `"${st.size}-${st.mtimeMs | 0}"`,
      'last-modified': st.mtime.toUTCString(),
    });
    if (req.method === 'HEAD') return res.end();
    // Streamed: memory stays flat however large the lake is.
    createReadStream(file).pipe(res);
  });
  return new Promise((resolveListen) => server.listen(port, host, () => resolveListen(server)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd] = process.argv.slice(2);
  const { values: opt } = parseArgs({ args: process.argv.slice(3), options: { out: { type: 'string' }, network: { type: 'string' }, root: { type: 'string' }, port: { type: 'string' } } });
  if (cmd === 'export') {
    const out = resolve(opt.out ?? '.cache/lake/istravex');
    const written = exportLake(out, { networks: opt.network ? [opt.network] : undefined });
    for (const [n, c] of Object.entries(written)) console.log(`${n}: ${c} ledgers → ${join(out, n)}`);
  } else if (cmd === 'serve') {
    const s = await startLakeServer({ root: opt.root ?? '.cache/lake', port: Number(opt.port ?? 9000) });
    console.log(`S3 endpoint http://127.0.0.1:${s.address().port} (path-style; buckets are the directories in ${opt.root ?? '.cache/lake'})`);
  } else {
    console.error('usage: node kit/datalake/lake.mjs export|serve [--out dir] [--network n] [--root dir] [--port n]');
    process.exit(2);
  }
}
