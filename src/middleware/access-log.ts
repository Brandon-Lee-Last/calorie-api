import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../app-types';

/** One structured line per request: method, path (never the query string), status, duration. */
export const accessLog = createMiddleware<AppEnv>(async (c, next) => {
  const start = Date.now();
  await next();
  c.get('logger').info('request', {
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: c.res.status,
    ms: Date.now() - start,
    userId: c.get('auth')?.userId,
  });
});
