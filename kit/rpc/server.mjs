// Mock Stellar RPC for offline replay. Serves the canonical ledgers in
// corpus/ledgers over JSON-RPC 2.0 with the same wire shapes as Stellar RPC
// (go-stellar-sdk protocols/rpc), so any RPC-backed indexer can ingest the
// corpus with no network, credentials or funds.
//
// Methods: getHealth, getNetwork, getLatestLedger, getLedgers.
// Ledgers are decompressed on demand; at most CACHE_SIZE stay in memory.
//
//   node kit/rpc/server.mjs --network pubnet --port 8000
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { xdr } from '@stellar/stellar-sdk';
import { ROOT } from '../lib/fixture.mjs';

export const PASSPHRASE = {
  pubnet: 'Public Global Stellar Network ; September 2015',
  testnet: 'Test SDF Network ; September 2015',
  local: 'Standalone Network ; February 2017',
};
const CACHE_SIZE = 4;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 5;

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Index of the ledgers available for one network, plus a bounded decode cache. */
export function openLedgerStore(network, corpusDir = join(ROOT, 'corpus')) {
  const index = JSON.parse(readFileSync(join(corpusDir, 'ledgers', 'index.json'), 'utf8'))
    .filter((l) => l.network === network)
    .sort((a, b) => a.ledger - b.ledger);
  if (!index.length) throw new Error(`no ledgers for ${network}`);
  const cache = new Map();

  function load(entry) {
    if (cache.has(entry.ledger)) {
      const hit = cache.get(entry.ledger);
      cache.delete(entry.ledger);
      cache.set(entry.ledger, hit);
      return hit;
    }
    const raw = zstdDecompressSync(readFileSync(join(corpusDir, entry.path)));
    const batch = xdr.LedgerCloseMetaBatch.fromXDR(raw);
    const lcm = batch.ledgerCloseMetas.find((m) => (m.v2 ?? m.v1 ?? m.v0).ledgerHeader.header.ledgerSeq === entry.ledger);
    const header = (lcm.v2 ?? lcm.v1 ?? lcm.v0).ledgerHeader;
    const info = {
      hash: header.hash.toXDR('hex'),
      sequence: entry.ledger,
      ledgerCloseTime: String(header.header.scpValue.closeTime),
      headerXdr: header.toXDR('base64'),
      metadataXdr: lcm.toXDR('base64'),
      protocolVersion: header.header.ledgerVersion,
    };
    cache.set(entry.ledger, info);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    return info;
  }

  return {
    network,
    index,
    oldest: () => load(index[0]),
    latest: () => load(index[index.length - 1]),
    /** Ledgers with sequence >= start, ascending, up to limit (the corpus may be sparse). */
    from: (start, limit) => index.filter((e) => e.ledger >= start).slice(0, limit).map(load),
  };
}

export function createHandler(store) {
  const methods = {
    getHealth() {
      const o = store.oldest();
      const l = store.latest();
      return {
        status: 'healthy',
        latestLedger: l.sequence,
        latestLedgerCloseTime: l.ledgerCloseTime,
        oldestLedger: o.sequence,
        oldestLedgerCloseTime: o.ledgerCloseTime,
        ledgerRetentionWindow: l.sequence - o.sequence + 1,
      };
    },
    getNetwork() {
      return { passphrase: PASSPHRASE[store.network], protocolVersion: store.latest().protocolVersion };
    },
    getLatestLedger() {
      const l = store.latest();
      return { id: l.hash, protocolVersion: l.protocolVersion, sequence: l.sequence };
    },
    getLedgers(params = {}) {
      const o = store.oldest();
      const l = store.latest();
      const p = params.pagination ?? {};
      if (params.xdrFormat && params.xdrFormat !== 'base64') throw new RpcError(-32602, 'only xdrFormat "base64" is supported');
      const limit = p.limit ?? DEFAULT_LIMIT;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new RpcError(-32602, `limit must be between 1 and ${MAX_LIMIT}`);
      let start;
      if (p.cursor !== undefined && p.cursor !== '') {
        if (params.startLedger) throw new RpcError(-32602, 'startLedger and cursor cannot both be set');
        start = Number(p.cursor) + 1;
        if (!Number.isInteger(start)) throw new RpcError(-32602, 'invalid cursor');
      } else {
        start = params.startLedger;
        if (!Number.isInteger(start)) throw new RpcError(-32602, 'startLedger is required');
        if (start < o.sequence || start > l.sequence) {
          throw new RpcError(-32600, `start ledger must be between the oldest ledger: ${o.sequence} and the latest ledger: ${l.sequence} for this rpc instance`);
        }
      }
      const ledgers = store.from(start, limit).map(({ protocolVersion, ...info }) => info);
      return {
        ledgers,
        latestLedger: l.sequence,
        latestLedgerCloseTime: Number(l.ledgerCloseTime),
        oldestLedger: o.sequence,
        oldestLedgerCloseTime: Number(o.ledgerCloseTime),
        cursor: String(ledgers.at(-1)?.sequence ?? start - 1),
      };
    },
  };

  return function handle(req) {
    const reply = (body) => ({ jsonrpc: '2.0', id: req?.id ?? null, ...body });
    if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      return reply({ error: { code: -32600, message: 'invalid request' } });
    }
    const fn = methods[req.method];
    if (!fn) return reply({ error: { code: -32601, message: `method not found: ${req.method}` } });
    try {
      return reply({ result: fn(req.params) });
    } catch (err) {
      return reply({ error: { code: err.code ?? -32603, message: err.message } });
    }
  };
}

export function startServer({ network, port = 0, corpusDir } = {}) {
  const handle = createHandler(openLedgerStore(network, corpusDir));
  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        body = Array.isArray(parsed) ? parsed.map(handle) : handle(parsed);
      } catch {
        body = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } };
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d) => {
    const i = process.argv.indexOf(`--${k}`);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const network = arg('network', 'pubnet');
  const server = await startServer({ network, port: Number(arg('port', 8000)) });
  console.log(`mock ${network} RPC on http://127.0.0.1:${server.address().port}`);
}
