// Entry point: `node server/index.ts` (Node 24 runs TypeScript natively).
//   PORT        listen port (default 8080)
//   CORPUS_DIR  corpus directory (default ./corpus)
//   GIT_SHA     version reported by /v1/health
import { serve } from '@hono/node-server';
import { resolve } from 'node:path';
import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 8080);
const corpusDir = resolve(process.env.CORPUS_DIR ?? 'corpus');
const app = createApp({
  corpusDir,
  version: process.env.GIT_SHA ?? 'dev',
  log: (line) => process.stdout.write(JSON.stringify(line) + '\n'),
});

const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), msg: 'listening', port: info.port, corpus: corpusDir }) + '\n');
});

// Graceful shutdown: stop accepting, let in-flight requests finish.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
