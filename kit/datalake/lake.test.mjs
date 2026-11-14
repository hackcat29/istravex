// The data-lake export matches SDF's public data lake layout and bytes, and
// the S3 endpoint answers the calls go-stellar-sdk's datastore makes.
//   node --test kit/datalake/lake.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../lib/fixture.mjs';
import { exportLake, objectKey, startLakeServer } from './lake.mjs';

test('object keys follow the data lake schema', () => {
  // Real object: aws-public-blockchain/v1.1/stellar/ledgers/pubnet/FC18F9FF--65472000-65535999/FC18F118--65474279.xdr.zst
  assert.equal(objectKey(65474279), 'FC18F9FF--65472000-65535999/FC18F118--65474279.xdr.zst');
  assert.equal(objectKey(3), 'FFFFFFFF--0-63999/FFFFFFFC--3.xdr.zst');
});

test('export writes the config and the stored objects byte for byte; the endpoint serves them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'istravex-lake-'));
  try {
    const written = exportLake(join(root, 'istravex'), { networks: ['pubnet'] });
    assert.equal(written.pubnet, 2);
    const config = JSON.parse(readFileSync(join(root, 'istravex', 'pubnet', '.config.json'), 'utf8'));
    assert.deepEqual(config, {
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
      version: '1.0',
      compression: 'zstd',
      ledgersPerBatch: 1,
      batchesPerPartition: 64000,
    });
    const stored = readFileSync(join(ROOT, 'corpus', 'ledgers', 'pubnet', '65474279.xdr.zst'));
    const server = await startLakeServer({ root });
    const base = `http://127.0.0.1:${server.address().port}/istravex`;
    try {
      const obj = await fetch(`${base}/pubnet/${objectKey(65474279)}`);
      assert.equal(obj.status, 200);
      assert.ok(Buffer.from(await obj.arrayBuffer()).equals(stored));
      assert.ok(obj.headers.get('x-amz-checksum-crc32'));
      const head = await fetch(`${base}/pubnet/.config.json`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(Number(head.headers.get('content-length')), readFileSync(join(root, 'istravex', 'pubnet', '.config.json')).length);
      const list = await (await fetch(`${base}?list-type=2&prefix=pubnet/&max-keys=1`)).text();
      assert.match(list, /<KeyCount>1<\/KeyCount>/);
      assert.match(list, /<IsTruncated>true<\/IsTruncated>/);
      assert.equal((await fetch(`${base}/pubnet/nope.xdr.zst`)).status, 404);
      assert.equal((await fetch(`${base}/../../etc/passwd`)).status, 404);
    } finally {
      server.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
