import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { zstdDecompressSync } from 'node:zlib';
import { createApp } from './app.ts';

const corpusDir = resolve(import.meta.dirname, '..', 'corpus');
const app = createApp({ corpusDir, version: 'test' });
// Test-only: response bodies are asserted field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const rpc = (network: string, body: unknown) =>
  app.request(`/rpc/${network}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('health reports version and RPC networks', async () => {
  const r = await app.request('/v1/health');
  assert.equal(r.status, 200);
  const j = await json(r);
  assert.equal(j.status, 'ok');
  assert.equal(j.version, 'test');
  assert.deepEqual(j.rpc_networks.sort(), ['local', 'pubnet', 'testnet']);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

// The committed corpus, counted straight from disk.
const fixtureDirs = readdirSync(resolve(corpusDir, 'fixtures'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

test('stats summarise the committed results', async () => {
  const j = await json(app.request('/v1/stats'));
  assert.equal(j.fixtures, fixtureDirs.length);
  assert.equal(j.sdk_checks.passed, j.sdk_checks.total);
  assert.equal(j.provenance_checks.passed, j.provenance_checks.total);
  assert.equal(j.golden_frames.exact, j.golden_frames.total);
});

test('fixtures list and filter by CAP and network', async () => {
  const all = (await json(app.request('/v1/fixtures'))).fixtures;
  assert.equal(all.length, fixtureDirs.length);
  const muxed = (await json(app.request('/v1/fixtures?cap=cap-0027'))).fixtures;
  assert.deepEqual(muxed.map((f: { id: string }) => f.id).sort(), fixtureDirs.filter((d) => d.startsWith('cap27-') || d === 'cap46-muxed-soroban-source-local-0001').sort());
  const local = (await json(app.request('/v1/fixtures?network=local'))).fixtures;
  assert.ok(local.every((f: { kind: string }) => f.kind === 'generated'));
});

test('fixture manifest, and 404 for unknown ids', async () => {
  const m = await json(app.request('/v1/fixtures/cap27-muxed-payment-pubnet-0001'));
  assert.equal(m.expected_decoded.muxed_id, '1764988090084626463');
  const missing = await app.request('/v1/fixtures/nope');
  assert.equal(missing.status, 404);
  assert.equal((await json(missing)).error.code, 'not_found');
});

test('fixture files serve base64 and binary with matching sha256', async () => {
  const b64 = await app.request('/v1/fixtures/cap27-muxed-payment-pubnet-0001/files/envelope');
  const text = (await b64.text()).trim();
  const bin = await app.request('/v1/fixtures/cap27-muxed-payment-pubnet-0001/files/envelope?encoding=binary');
  const bytes = new Uint8Array(await bin.arrayBuffer());
  assert.equal(b64.headers.get('x-xdr-type'), 'TransactionEnvelope');
  assert.equal(Buffer.from(text, 'base64').compare(Buffer.from(bytes)), 0);
  assert.equal(sha(bytes), bin.headers.get('x-content-sha256'));
});

test('ledger downloads decompress to the indexed sha256', async () => {
  const r = await app.request('/v1/ledgers/pubnet/65474279');
  assert.equal(r.status, 200);
  const raw = zstdDecompressSync(Buffer.from(await r.arrayBuffer()));
  assert.equal(sha(raw), r.headers.get('x-content-sha256'));
  assert.equal((await app.request('/v1/ledgers/pubnet/1')).status, 404);
});

test('results and coverage are served as committed', async () => {
  const names = (await json(app.request('/v1/results'))).results;
  for (const n of ['provenance', 'javascript', 'go', 'rust', 'replay', 'pilot-wallet-backend', 'goldens-go']) assert.ok(names.includes(n), n);
  const committed = JSON.parse(readFileSync(resolve(corpusDir, 'results', 'provenance.json'), 'utf8'));
  assert.deepEqual(await json(app.request('/v1/results/provenance')), committed);
  assert.equal((await json(app.request('/v1/coverage'))).live_caps, 70);
});

test('findings are served as committed, and synthetic fixtures list without a ledger', async () => {
  const committed = JSON.parse(readFileSync(resolve(corpusDir, 'findings.json'), 'utf8'));
  assert.deepEqual(await json(app.request('/v1/findings')), committed);
  const { fixtures } = await json(app.request('/v1/fixtures'));
  const synthetic = fixtures.filter((f: { synthetic: boolean }) => f.synthetic);
  assert.ok(synthetic.length >= 1);
  for (const f of synthetic) assert.equal(f.ledger, null);
  assert.ok(fixtures.every((f: { pattern: string }) => f.pattern));
});

test('RPC replays the corpus over JSON-RPC', async () => {
  const health = await json(rpc('pubnet', { jsonrpc: '2.0', id: 1, method: 'getHealth' }));
  assert.equal(health.result.oldestLedger, 65474279);
  const got = await json(rpc('pubnet', { jsonrpc: '2.0', id: 2, method: 'getLedgers', params: { startLedger: 65474279, pagination: { limit: 1 } } }));
  assert.equal(got.result.ledgers[0].sequence, 65474279);
  const batch = await json(rpc('local', [{ jsonrpc: '2.0', id: 1, method: 'getNetwork' }, { jsonrpc: '2.0', id: 2, method: 'nope' }]));
  assert.equal(batch[0].result.passphrase, 'Standalone Network ; February 2017');
  assert.equal(batch[1].error.code, -32601);
  assert.equal((await rpc('futurenet', { jsonrpc: '2.0', id: 1, method: 'getHealth' })).status, 404);
  const bad = await app.request('/rpc/pubnet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal((await json(bad)).error.code, -32700);
  const big = await app.request('/rpc/pubnet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(70_000) }) });
  assert.equal(big.status, 413);
});

test('security, CORS and rate-limit headers', async () => {
  const r = await app.request('/v1/stats', { headers: { origin: 'https://example.com' } });
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(r.headers.get('ratelimit-limit'));
  assert.ok(r.headers.get('etag'));
});

test('rate limiting returns 429 with Retry-After', async () => {
  const tight = createApp({ corpusDir, limits: [2, 2] });
  const hit = () => tight.request('/v1/stats', { headers: { 'x-forwarded-for': '203.0.113.9' } });
  assert.equal((await hit()).status, 200);
  assert.equal((await hit()).status, 200);
  const third = await hit();
  assert.equal(third.status, 429);
  assert.ok(Number(third.headers.get('retry-after')) > 0);
});

test('every OpenAPI path is served', async () => {
  const spec = await json(app.request('/openapi.json'));
  const sample: Record<string, string> = { id: 'cap27-muxed-payment-pubnet-0001', name: 'envelope', network: 'pubnet', seq: '65474279' };
  for (const [path, ops] of Object.entries(spec.paths as Record<string, Record<string, unknown>>)) {
    let url = path.replace(/\{(\w+)\}/g, (_, k) => sample[k]);
    if (url === '/v1/results/envelope') url = '/v1/results/provenance';
    for (const method of Object.keys(ops)) {
      const r = method === 'post' ? await rpc('pubnet', { jsonrpc: '2.0', id: 1, method: 'getHealth' }) : await app.request(url);
      assert.notEqual(r.status, 404, `${method.toUpperCase()} ${url}`);
    }
  }
});
