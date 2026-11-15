import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { xdr } from '@stellar/stellar-sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/fixture.mjs';
import { PASSPHRASE, startServer } from './server.mjs';

// The corpus's pubnet ledgers, read from its index.
const PUBNET = JSON.parse(readFileSync(join(ROOT, 'corpus', 'ledgers', 'index.json'), 'utf8')).filter((l) => l.network === 'pubnet').map((l) => l.ledger).sort((a, b) => a - b);
const OLDEST = PUBNET[0];

let server;
let url;
const call = async (method, params) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }) });
  return r.json();
};

before(async () => {
  server = await startServer({ network: 'pubnet' });
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('getHealth reports the corpus range with string close times', async () => {
  const { result } = await call('getHealth');
  assert.equal(result.status, 'healthy');
  assert.equal(result.oldestLedger, OLDEST);
  assert.equal(result.latestLedger, 65474309);
  assert.equal(typeof result.latestLedgerCloseTime, 'string');
});

test('getNetwork returns the pubnet passphrase and protocol from the header', async () => {
  const { result } = await call('getNetwork');
  assert.equal(result.passphrase, PASSPHRASE.pubnet);
  assert.equal(result.protocolVersion, 29);
});

test('getLedgers returns canonical LedgerCloseMeta that decodes', async () => {
  const { result } = await call('getLedgers', { startLedger: OLDEST, pagination: { limit: 1 } });
  assert.equal(result.ledgers.length, 1);
  const [l] = result.ledgers;
  assert.equal(l.sequence, OLDEST);
  assert.equal(typeof l.ledgerCloseTime, 'string');
  assert.equal(typeof result.latestLedgerCloseTime, 'number');
  const lcm = xdr.LedgerCloseMeta.fromXDR(l.metadataXdr, 'base64');
  assert.equal(lcm.v2.ledgerHeader.header.ledgerSeq, OLDEST);
  assert.equal(xdr.LedgerHeaderHistoryEntry.fromXDR(l.headerXdr, 'base64').hash.toXDR('hex'), l.hash);
  assert.equal(result.cursor, String(OLDEST));
});

test('getLedgers pages with a cursor over a sparse corpus', async () => {
  const first = await call('getLedgers', { startLedger: OLDEST, pagination: { limit: 1 } });
  const next = await call('getLedgers', { pagination: { cursor: first.result.cursor, limit: 5 } });
  assert.deepEqual(next.result.ledgers.map((l) => l.sequence), PUBNET.slice(1, 6));
});

test('errors follow JSON-RPC codes', async () => {
  assert.equal((await call('getLedgers', { startLedger: 1 })).error.code, -32600);
  assert.equal((await call('getLedgers', { startLedger: OLDEST, pagination: { limit: 999 } })).error.code, -32602);
  assert.equal((await call('getEvents', {})).error.code, -32601);
  const bad = await (await fetch(url, { method: 'POST', body: '{' })).json();
  assert.equal(bad.error.code, -32700);
});
