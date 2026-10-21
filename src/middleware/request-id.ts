import { createMiddleware } from 'hono/factory';
import { newId } from '../core/ids';
import type { AppEnv } from '../app-types';

const SAFE = /^[A-Za-z0-9_-]{8,64}$/;

/** Use the caller's request id when it looks sane (so a trace can span app and API), else make one. */
export const requestId = createMiddleware<AppEnv>(async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const id = incoming && SAFE.test(incoming) ? incoming : newId();
  c.set('requestId', id);
  await next();
  c.header('x-request-id', id);
});
