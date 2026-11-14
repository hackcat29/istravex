import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { xdr } from '@stellar/stellar-sdk';
import { PASSPHRASE, startServer } from './server.mjs';

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
  assert.equal(result.oldestLedger, 65474279);
  assert.equal(result.latestLedger, 65474309);
  assert.equal(typeof result.latestLedgerCloseTime, 'string');
});

test('getNetwork returns the pubnet passphrase and protocol from the header', async () => {
  const { result } = await call('getNetwork');
  assert.equal(result.passphrase, PASSPHRASE.pubnet);
  assert.equal(result.protocolVersion, 29);
});

test('getLedgers returns canonical LedgerCloseMeta that decodes', async () => {
  const { result } = await call('getLedgers', { startLedger: 65474279, pagination: { limit: 1 } });
  assert.equal(result.ledgers.length, 1);
  const [l] = result.ledgers;
  assert.equal(l.sequence, 65474279);
  assert.equal(typeof l.ledgerCloseTime, 'string');
  assert.equal(typeof result.latestLedgerCloseTime, 'number');
  const lcm = xdr.LedgerCloseMeta.fromXDR(l.metadataXdr, 'base64');
  assert.equal(lcm.v2.ledgerHeader.header.ledgerSeq, 65474279);
  assert.equal(xdr.LedgerHeaderHistoryEntry.fromXDR(l.headerXdr, 'base64').hash.toXDR('hex'), l.hash);
  assert.equal(result.cursor, '65474279');
});

test('getLedgers pages with a cursor over a sparse corpus', async () => {
  const first = await call('getLedgers', { startLedger: 65474279, pagination: { limit: 1 } });
  const next = await call('getLedgers', { pagination: { cursor: first.result.cursor, limit: 5 } });
  assert.deepEqual(next.result.ledgers.map((l) => l.sequence), [65474309]);
});

test('errors follow JSON-RPC codes', async () => {
  assert.equal((await call('getLedgers', { startLedger: 1 })).error.code, -32600);
  assert.equal((await call('getLedgers', { startLedger: 65474279, pagination: { limit: 999 } })).error.code, -32602);
  assert.equal((await call('getEvents', {})).error.code, -32601);
  const bad = await (await fetch(url, { method: 'POST', body: '{' })).json();
  assert.equal(bad.error.code, -32700);
});
