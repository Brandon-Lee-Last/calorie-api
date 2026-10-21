import { createMiddleware } from 'hono/factory';
import { unauthorized } from '../core/errors';
import type { AppEnv } from '../app-types';

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m ? m[1]! : null;
}

/** Rejects the request unless it carries a valid access token. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearer(c.req.header('authorization'));
  if (!token) throw unauthorized();
  const claims = await c.get('deps').auth.verifyAccess(token);
  c.set('auth', { userId: claims.userId, sessionId: claims.sessionId });
  await next();
});

/** No header is fine; a header that is present but wrong is not (so an expired token is not silently ignored). */
export const optionalAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('authorization');
  if (header) {
    const token = bearer(header);
    if (!token) throw unauthorized();
    const claims = await c.get('deps').auth.verifyAccess(token);
    c.set('auth', { userId: claims.userId, sessionId: claims.sessionId });
  }
  await next();
});
