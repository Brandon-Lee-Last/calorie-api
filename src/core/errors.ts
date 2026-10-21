import type { ContentfulStatusCode } from 'hono/utils/http-status';

export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthorized'
  | 'token_expired'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'subscription_required'
  | 'upstream_failed'
  | 'not_configured'
  | 'resync_required'
  | 'internal_error';

/** An error the API intends to show to the client. Anything else becomes a generic 500. */
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, details);
export const validationFailed = (details: unknown, message = 'The request is not valid') =>
  new AppError(422, 'validation_failed', message, details);
export const unauthorized = (message = 'Sign in required') => new AppError(401, 'unauthorized', message);
export const tokenExpired = () => new AppError(401, 'token_expired', 'The access token has expired');
export const forbidden = (message = 'You do not have access to this') =>
  new AppError(403, 'forbidden', message);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'conflict', message, details);
export const payloadTooLarge = (message = 'The request body is too large') =>
  new AppError(413, 'payload_too_large', message);
export const rateLimited = (retryAfterSeconds: number) =>
  new AppError(429, 'rate_limited', 'Too many requests, slow down', { retryAfterSeconds });
export const quotaExceeded = (key: string, limit: number) =>
  new AppError(429, 'quota_exceeded', `Daily limit reached for ${key}`, { key, limit });
export const subscriptionRequired = (feature: string) =>
  new AppError(402, 'subscription_required', `${feature} needs a Pro subscription`, { feature });
export const upstreamFailed = (service: string, message?: string) =>
  new AppError(502, 'upstream_failed', message ?? `${service} is not available right now`, { service });
export const notConfigured = (what: string) =>
  new AppError(501, 'not_configured', `${what} is not configured`);

export const resyncRequired = () =>
  new AppError(
    409,
    'resync_required',
    'Too much time has passed since this device last synced. Clear the local copy and sync from the start (since=0).',
  );

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
