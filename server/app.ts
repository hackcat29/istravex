// The Istravex API: the corpus, canonical ledgers and kit results over HTTP,
// plus the mock Stellar RPC as a public replay endpoint.
//
//   GET  /v1/...            read-only corpus API (see server/openapi.json)
//   POST /rpc/{network}     mock Stellar RPC: getHealth, getNetwork,
//                           getLatestLedger, getLedgers
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { etag } from 'hono/etag';
import { secureHeaders } from 'hono/secure-headers';
import { createHandler, openLedgerStore, type JsonRpcRequest } from '../kit/rpc/server.mjs';
import { loadCorpus } from './data.ts';
import { rateLimit } from './limits.ts';

export type AppOptions = {
  corpusDir: string;
  version?: string;
  /** Requests per minute per client: [read API, RPC]. */
  limits?: [number, number];
  log?: (line: Record<string, unknown>) => void;
};

const NETWORKS = ['pubnet', 'testnet', 'local'] as const;
type Network = (typeof NETWORKS)[number];

const notFound = (c: Context, what: string) => c.json({ error: { code: 'not_found', message: `${what} not found` } }, 404);
const clientIp = (c: Context) => c.req.header('x-forwarded-for')?.split(',')[0].trim() || c.req.header('x-real-ip') || 'local';

export function createApp({ corpusDir, version = 'dev', limits = [1200, 300], log }: AppOptions) {
  const corpus = loadCorpus(corpusDir);
  const openapi = JSON.parse(readFileSync(new URL('./openapi.json', import.meta.url), 'utf8'));
  const rpc = new Map<Network, ReturnType<typeof createHandler>>();
  for (const n of NETWORKS) {
    if (corpus.ledgers.some((l) => l.network === n)) rpc.set(n, createHandler(openLedgerStore(n, corpusDir)));
  }
  const started = Date.now();
  const app = new Hono();

  app.use('*', async (c, next) => {
    const t0 = performance.now();
    await next();
    log?.({ t: new Date().toISOString(), method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - t0), ip: clientIp(c) });
  });
  app.use('*', secureHeaders({ crossOriginResourcePolicy: 'cross-origin' }));
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type'], maxAge: 86400 }));
  app.use('/v1/*', rateLimit({ limit: limits[0], windowMs: 60_000, key: clientIp }));
  app.use('/rpc/*', rateLimit({ limit: limits[1], windowMs: 60_000, key: clientIp }));
  app.use('/v1/*', etag());

  app.get('/', (c) => c.json({ name: 'Istravex API', version, docs: 'https://docs.istravex.com/api-reference/introduction', openapi: '/openapi.json' }));
  app.get('/openapi.json', (c) => c.json(openapi));

  // ── Read API ──────────────────────────────────────────────────────────────
  const cache = (c: Context, seconds: number) => c.header('Cache-Control', `public, max-age=${seconds}`);

  app.get('/v1/health', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ status: 'ok', version, uptime_s: Math.round((Date.now() - started) / 1000), fixtures: corpus.fixtures.size, rpc_networks: [...rpc.keys()] });
  });

  app.get('/v1/stats', (c) => (cache(c, 300), c.json(corpus.stats)));

  app.get('/v1/fixtures', (c) => {
    cache(c, 300);
    const cap = c.req.query('cap');
    const network = c.req.query('network');
    const items = [...corpus.fixtures.values()]
      .map(({ manifest: m }) => ({
        id: m.id,
        cap_ids: m.cap_ids,
        network: m.network,
        protocol_version: m.protocol_version,
        ledger: m.source.ledger,
        tx_hash: m.source.tx_hash,
        kind: m.source.kind,
        xdr_type: m.xdr_type,
        sha256: m.sha256,
        files: m.files.map((f) => f.name),
      }))
      .filter((f) => (!cap || f.cap_ids.includes(cap.toUpperCase())) && (!network || f.network === network));
    return c.json({ fixtures: items });
  });

  app.get('/v1/fixtures/:id', (c) => {
    const f = corpus.fixtures.get(c.req.param('id'));
    if (!f) return notFound(c, 'Fixture');
    cache(c, 300);
    return c.json(f.manifest);
  });

  app.get('/v1/fixtures/:id/files/:name', (c) => {
    const f = corpus.fixtures.get(c.req.param('id'));
    const name = c.req.param('name');
    const b64 = f?.blobs.get(name);
    if (!f || !b64) return notFound(c, 'File');
    const meta = f.manifest.files.find((x) => x.name === name)!;
    cache(c, 300);
    c.header('X-XDR-Type', meta.xdr_type);
    c.header('X-Content-SHA256', meta.sha256);
    if (c.req.query('encoding') === 'binary') {
      c.header('Content-Type', 'application/octet-stream');
      c.header('Content-Disposition', `attachment; filename="${f.manifest.id}-${name}.xdr"`);
      return c.body(new Uint8Array(Buffer.from(b64, 'base64')));
    }
    return c.text(b64 + '\n');
  });

  app.get('/v1/ledgers', (c) => (cache(c, 300), c.json({ ledgers: corpus.ledgers })));

  app.get('/v1/ledgers/:network/:seq', (c) => {
    const entry = corpus.ledgers.find((l) => l.network === c.req.param('network') && l.ledger === Number(c.req.param('seq')));
    if (!entry) return notFound(c, 'Ledger');
    cache(c, 3600);
    c.header('Content-Type', 'application/zstd');
    c.header('X-XDR-Type', 'LedgerCloseMetaBatch');
    c.header('X-Content-SHA256', entry.sha256);
    c.header('Content-Disposition', `attachment; filename="${entry.network}-${entry.ledger}.xdr.zst"`);
    return c.body(new Uint8Array(readFileSync(join(corpus.dir, entry.path))));
  });

  app.get('/v1/results', (c) => (cache(c, 300), c.json({ results: [...corpus.results.keys()] })));
  app.get('/v1/results/:name', (c) => {
    const r = corpus.results.get(c.req.param('name'));
    if (!r) return notFound(c, 'Result');
    cache(c, 300);
    return c.json(r);
  });

  app.get('/v1/coverage', (c) => (corpus.coverage ? (cache(c, 3600), c.json(corpus.coverage)) : notFound(c, 'Coverage')));

  // ── Mock Stellar RPC ──────────────────────────────────────────────────────
  app.post('/rpc/:network', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'request too large' } }, 413) }), async (c) => {
    const handler = rpc.get(c.req.param('network') as Network);
    if (!handler) return notFound(c, 'Network');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    if (Array.isArray(body)) {
      if (body.length > 20) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batch too large (max 20)' } });
      return c.json(body.map((r) => handler(r as JsonRpcRequest)));
    }
    return c.json(handler(body as JsonRpcRequest));
  });

  app.notFound((c) => notFound(c, 'Route'));
  app.onError((err, c) => {
    log?.({ t: new Date().toISOString(), level: 'error', path: c.req.path, error: String(err) });
    return c.json({ error: { code: 'internal', message: 'Internal error' } }, 500);
  });
  return app;
}
