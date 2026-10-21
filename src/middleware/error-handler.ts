import type { ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { AppError, isAppError } from '../core/errors';
import type { ErrorCode } from '../core/errors';
import type { AppEnv } from '../app-types';

function body(code: ErrorCode, message: string, requestId: string, details?: unknown) {
  return { error: { code, message, ...(details === undefined ? {} : { details }), requestId } };
}

export function zodDetails(e: ZodError) {
  return e.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code }));
}

export const onError: ErrorHandler<AppEnv> = async (err, c) => {
  const requestId = c.get('requestId') ?? 'unknown';
  const logger = c.get('logger');

  if (isAppError(err)) {
    // 503 is a deliberate "not now" (maintenance, a switched-off feature, a spent budget), not a fault.
    if (err.status >= 500 && err.status !== 503)
      logger?.error('app error', { code: err.code, message: err.message });
    const retry = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
    if (retry) c.header('retry-after', String(retry));
    return c.json(body(err.code, err.message, requestId, err.details), err.status);
  }
  if (err instanceof ZodError) {
    return c.json(body('validation_failed', 'The request is not valid', requestId, zodDetails(err)), 422);
  }
  if (err instanceof HTTPException) {
    const code: ErrorCode =
      err.status === 401
        ? 'unauthorized'
        : err.status === 403
          ? 'forbidden'
          : err.status === 413
            ? 'payload_too_large'
            : 'bad_request';
    return c.json(body(code, err.message || 'Request failed', requestId), err.status as AppError['status']);
  }
  // A real bug or a failed dependency. Log everything, tell the caller nothing internal.
  logger?.error('unhandled error', { name: err.name, message: err.message, stack: err.stack });
  const alerted = c.get('deps')?.alerts.notify({
    key: `error:${err.name}:${err.message.slice(0, 80)}`,
    title: `Unexpected error on ${c.req.method} ${new URL(c.req.url).pathname}`,
    detail: `${err.name}: ${err.message.slice(0, 200)}\nrequest ${requestId}`,
  });
  if (alerted) {
    try {
      c.executionCtx.waitUntil(alerted);
    } catch {
      await alerted; // no execution context (tests, local scripts): wait for it instead
    }
  }
  return c.json(body('internal_error', 'Something went wrong on our side', requestId), 500);
};

export const onNotFound: NotFoundHandler<AppEnv> = (c) =>
  c.json(body('not_found', 'No such route', c.get('requestId') ?? 'unknown'), 404);
