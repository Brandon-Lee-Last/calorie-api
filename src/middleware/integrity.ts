import { createMiddleware } from 'hono/factory';
import { AppError } from '../core/errors';
import type { AppEnv } from '../app-types';

/**
 * Where integrity checking is on, the request must carry `x-integrity-token` (from Play Integrity) and `x-integrity-challenge`
 * (from `GET /auth/challenge`). Where it is off, this does nothing.
 */
export const requireIntegrity = createMiddleware<AppEnv>(async (c, next) => {
  const verifier = c.get('deps').integrity;
  if (verifier.required) {
    const ok = await verifier.verify(
      c.req.header('x-integrity-token') ?? null,
      c.req.header('x-integrity-challenge') ?? null,
    );
    if (!ok) throw new AppError(403, 'integrity_failed', 'This device or app could not be verified');
  }
  await next();
});
