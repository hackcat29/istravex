// The replay harness keeps memory bounded on a large corpus: 400 pubnet-sized
// ledgers (1.4 MB of LedgerCloseMeta each, ~540 MB in all) are paged through
// getLedgers from a mock RPC in its own process, with its heap capped at
// HEAP_MB. A server whose memory grew with the corpus would run out part-way;
// this one serves all of it, and its resident memory stays flat.
//   node --test kit/rpc/memory.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { xdr } from '@stellar/stellar-sdk';
import { ROOT } from '../lib/fixture.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { MAX_RESPONSE_BYTES } from './server.mjs';

const N = 400;
const HEAP_MB = 128;
const SOURCE = 65474279;

/** A corpus of N copies of a real pubnet ledger, renumbered N consecutive sequences. */
function bigCorpus() {
  const dir = mkdtempSync(join(tmpdir(), 'istravex-memory-'));
  const raw = zstdDecompressSync(readFileSync(join(ROOT, 'corpus', 'ledgers', 'pubnet', `${SOURCE}.xdr.zst`)));
  const lcm = xdr.LedgerCloseMetaBatch.fromXDR(raw).ledgerCloseMetas[0];
  // Locate ledgerSeq inside the header's own encoding, then patch copies in place.
  const header = Buffer.from(lcm.v2.ledgerHeader.header.toXDR());
  const seqBytes = Buffer.alloc(4);
  seqBytes.writeUInt32BE(SOURCE);
  const headerAt = raw.indexOf(header);
  const seqAt = headerAt + header.indexOf(seqBytes);
  assert.ok(headerAt > 0 && seqAt > headerAt, 'ledger header located');
  mkdirSync(join(dir, 'ledgers', 'pubnet'), { recursive: true });
  const index = [];
  for (let i = 0; i < N; i++) {
    const seq = SOURCE + i;
    const copy = Buffer.from(raw);
    copy.writeUInt32BE(seq, 0); // batch startSequence
    copy.writeUInt32BE(seq, 4); // batch endSequence
    copy.writeUInt32BE(seq, seqAt);
    const path = `ledgers/pubnet/${seq}.xdr.zst`;
    writeFileSync(join(dir, path), zstdCompressSync(copy));
    index.push({ network: 'pubnet', ledger: seq, path, xdr_type: 'LedgerCloseMetaBatch' });
  }
  writeFileSync(join(dir, 'ledgers', 'index.json'), JSON.stringify(index));
  return { dir, ledgerBytes: raw.length };
}

const rssMB = (pid) => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024;

test('getLedgers pages a 400-ledger corpus with flat memory', { timeout: 300_000 }, async (t) => {
  const { dir, ledgerBytes } = bigCorpus();
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [`--max-old-space-size=${HEAP_MB}`, join(ROOT, 'kit', 'rpc', 'server.mjs'), '--network', 'pubnet', '--port', String(port)], {
    env: { ...process.env, ISTRAVEX_CORPUS: dir },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => child.stdout.once('data', resolve));
  const url = `http://127.0.0.1:${port}`;
  try {
    const samples = [];
    let cursor;
    let seen = 0;
    let pages = 0;
    while (seen < N) {
      const params = cursor ? { pagination: { cursor, limit: 200 } } : { startLedger: SOURCE, pagination: { limit: 200 } };
      const body = await (await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLedgers', params }) })).json();
      const { ledgers } = body.result;
      assert.ok(ledgers.length >= 1, 'every page has at least one ledger');
      const bytes = ledgers.reduce((n, l) => n + l.metadataXdr.length, 0);
      assert.ok(ledgers.length === 1 || bytes <= MAX_RESPONSE_BYTES, `page within ${MAX_RESPONSE_BYTES} B (${bytes})`);
      seen += ledgers.length;
      cursor = body.result.cursor;
      pages++;
      samples.push(rssMB(child.pid));
    }
    assert.equal(seen, N);
    const total = (N * ledgerBytes) / 2 ** 20;
    const half = Math.floor(samples.length / 2);
    const max = (xs) => Math.max(...xs);
    t.diagnostic(
      `${N} ledgers, ${total.toFixed(0)} MB of meta, ${pages} pages, heap capped at ${HEAP_MB} MB; server RSS: first page ${samples[0].toFixed(0)} MB, ` +
        `peak in first half ${max(samples.slice(0, half)).toFixed(0)} MB, in second half ${max(samples.slice(half)).toFixed(0)} MB`,
    );
    // Bounded: the capped server served every ledger, and the second half of
    // the sweep needed no more memory than the first (plus allocator noise).
    assert.equal(child.exitCode, null, 'server still running');
    assert.ok(max(samples.slice(half)) - max(samples.slice(0, half)) < 32, 'resident memory does not grow across the sweep');
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
