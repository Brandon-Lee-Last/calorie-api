import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AppEnv } from '../app-types';
import { Container } from '../container';
import { forbidden, quotaExceeded, rateLimited } from '../core/errors';
import { silentLogger } from '../core/logger';
import { MemoryRateLimiter } from '../core/rate-limiter';
import { FakeClock } from '../core/time';
import { onError, onNotFound } from './error-handler';
import { rateLimit } from './rate-limit';
import { requestId } from './request-id';

function harness() {
  const clock = new FakeClock(0);
  const limiter = new MemoryRateLimiter(clock);
  const app = new Hono<AppEnv>();
  app.use('*', requestId);
  app.use('*', async (c, next) => {
    const deps = new Container(env, { clock, logger: silentLogger, rateLimiter: limiter });
    c.set('deps', deps);
    c.set('logger', deps.logger);
    await next();
  });
  app.get('/app-error', () => {
    throw forbidden('nope');
  });
  app.get('/quota', () => {
    throw quotaExceeded('ai', 5);
  });
  app.get('/retry', () => {
    throw rateLimited(9);
  });
  app.get('/zod', () => {
    z.object({ n: z.number() }).parse({ n: 'x' });
    return new Response('unreachable');
  });
  app.get('/http-401', () => {
    throw new HTTPException(401, { message: 'bad token' });
  });
  app.get('/http-413', () => {
    throw new HTTPException(413);
  });
  app.get('/http-418', () => {
    throw new HTTPException(418, { message: 'teapot' });
  });
  app.get('/boom', () => {
    throw new Error('database password is hunter2');
  });
  app.get('/limited', rateLimit({ name: 'test', limit: 2, windowSeconds: 60 }), (c) => c.text('ok'));
  app.get('/limited-user', rateLimit({ name: 'u', limit: 1, windowSeconds: 60, by: 'user' }), (c) =>
    c.text('ok'),
  );
  app.onError(onError);
  app.notFound(onNotFound);
  return { app, clock };
}

const get = (app: Hono<AppEnv>, path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers }, env);

describe('error handler', () => {
  it('formats AppErrors with code, message and request id', async () => {
    const { app } = harness();
    const res = await get(app, '/app-error');
    expect(res.status).toBe(403);
    const b = (await res.json()) as any;
    expect(b.error).toMatchObject({ code: 'forbidden', message: 'nope' });
    expect(b.error.requestId).toBe(res.headers.get('x-request-id'));
  });
  it('includes details and sets Retry-After for rate limits', async () => {
    const { app } = harness();
    const res = await get(app, '/retry');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('9');
    const quota = await get(app, '/quota');
    expect(((await quota.json()) as any).error.details).toEqual({ key: 'ai', limit: 5 });
  });
  it('turns a ZodError into a 422 listing the paths', async () => {
    const { app } = harness();
    const res = await get(app, '/zod');
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).error.details[0]).toMatchObject({ path: 'n' });
  });
  it('maps framework HTTP exceptions onto our codes', async () => {
    const { app } = harness();
    expect(((await (await get(app, '/http-401')).json()) as any).error.code).toBe('unauthorized');
    expect(((await (await get(app, '/http-413')).json()) as any).error.code).toBe('payload_too_large');
    expect(((await (await get(app, '/http-418')).json()) as any).error.code).toBe('bad_request');
  });
  it('hides the message of an unexpected error', async () => {
    const { app } = harness();
    const res = await get(app, '/boom');
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('internal_error');
    expect(text).not.toContain('hunter2');
  });
  it('404s unknown routes in the standard shape', async () => {
    const { app } = harness();
    const res = await get(app, '/missing');
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.code).toBe('not_found');
  });
});

describe('rate limit middleware', () => {
  it('lets a client through up to the limit, then answers 429 with Retry-After', async () => {
    const { app, clock } = harness();
    const h = { 'cf-connecting-ip': '1.2.3.4' };
    expect((await get(app, '/limited', h)).status).toBe(200);
    expect((await get(app, '/limited', h)).status).toBe(200);
    const blocked = await get(app, '/limited', h);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('60');
    expect((await get(app, '/limited', { 'cf-connecting-ip': '5.6.7.8' })).status).toBe(200);
    clock.advance(61_000);
    expect((await get(app, '/limited', h)).status).toBe(200);
  });
  it('falls back to the IP when the request has no signed-in user', async () => {
    const { app } = harness();
    const h = { 'cf-connecting-ip': '9.9.9.9' };
    expect((await get(app, '/limited-user', h)).status).toBe(200);
    expect((await get(app, '/limited-user', h)).status).toBe(429);
  });
  it('request-id keeps a good incoming id', async () => {
    const { app } = harness();
    const res = await get(app, '/limited', { 'x-request-id': 'abc12345-def', 'cf-connecting-ip': '7.7.7.7' });
    expect(res.headers.get('x-request-id')).toBe('abc12345-def');
  });
});
