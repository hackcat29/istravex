// Fixed-window, per-client rate limiting with IETF RateLimit headers.
// In memory: one API instance runs behind Caddy, so no shared store is needed.
import type { MiddlewareHandler } from 'hono';

export function rateLimit({ limit, windowMs, key }: { limit: number; windowMs: number; key: (c: Parameters<MiddlewareHandler>[0]) => string }): MiddlewareHandler {
  const hits = new Map<string, { count: number; reset: number }>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  sweep.unref();

  return async (c, next) => {
    const now = Date.now();
    const id = key(c);
    let w = hits.get(id);
    if (!w || w.reset <= now) {
      w = { count: 0, reset: now + windowMs };
      hits.set(id, w);
    }
    w.count++;
    const remaining = Math.max(0, limit - w.count);
    const resetSec = Math.ceil((w.reset - now) / 1000);
    c.header('RateLimit-Limit', String(limit));
    c.header('RateLimit-Remaining', String(remaining));
    c.header('RateLimit-Reset', String(resetSec));
    if (w.count > limit) {
      c.header('Retry-After', String(resetSec));
      return c.json({ error: { code: 'rate_limited', message: `Too many requests; retry in ${resetSec}s` } }, 429);
    }
    await next();
  };
}
