import { describe, expect, it } from 'vitest';
import { body, makeApp } from '../test/helpers/app';
import { getConfig } from './env';
import { env } from 'cloudflare:workers';

describe('app shell', () => {
  it('answers /v1/health with an echoed request id and security headers', async () => {
    const { request } = makeApp();
    const res = await request('/v1/health', { headers: { 'x-request-id': 'trace-abcdef12' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('trace-abcdef12');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await body(res)).toMatchObject({ status: 'ok', environment: 'local' });
  });
  it('makes its own request id when the caller sends nothing or something odd', async () => {
    const { request } = makeApp();
    const a = await request('/v1/health');
    const b = await request('/v1/health', { headers: { 'x-request-id': 'bad id with spaces' } });
    expect(a.headers.get('x-request-id')).toHaveLength(26);
    expect(b.headers.get('x-request-id')).toHaveLength(26);
  });
  it('readiness checks the database and storage', async () => {
    const { request } = makeApp();
    const res = await request('/v1/health/ready');
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ status: 'ok', checks: { database: 'ok', storage: 'ok' } });
  });
  it('returns the standard error body for unknown routes', async () => {
    const { request } = makeApp();
    const res = await request('/v1/nope');
    expect(res.status).toBe(404);
    const b = await body(res);
    expect(b.error).toMatchObject({ code: 'not_found' });
    expect(typeof b.error.requestId).toBe('string');
  });
  it('rejects oversized bodies', async () => {
    const { request } = makeApp();
    const res = await request('/v1/health', {
      method: 'POST',
      body: 'x'.repeat(1024 * 1024 + 10),
      headers: { 'content-type': 'text/plain' },
    });
    expect(res.status).toBe(413);
    expect((await body(res)).error.code).toBe('payload_too_large');
  });
  it('serves an OpenAPI document that lists the routes', async () => {
    const { request } = makeApp();
    const res = await request('/v1/openapi.json');
    const doc = await body(res);
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/v1/health');
  });
  it('allows CORS only for configured origins', async () => {
    const { app } = makeApp();
    const withOrigin = { ...env, CORS_ORIGINS: 'https://app.example.com' };
    const ok = await app.request(
      '/v1/health',
      { headers: { origin: 'https://app.example.com' } },
      withOrigin,
    );
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    const none = await app.request(
      '/v1/health',
      { headers: { origin: 'https://evil.example.com' } },
      withOrigin,
    );
    expect(none.headers.get('access-control-allow-origin')).toBeNull();
    const off = await app.request('/v1/health', { headers: { origin: 'https://app.example.com' } }, env);
    expect(off.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('config', () => {
  it('parses the test environment', () => {
    const c = getConfig({ ...env });
    expect(c.ENVIRONMENT).toBe('local');
    expect(c.GOOGLE_CLIENT_IDS).toEqual([]);
    expect(c.SIMULATE_ENABLED).toBe(true);
    expect(c.isProduction).toBe(false);
  });
  it('rejects weak or missing secrets', () => {
    expect(() => getConfig({ ...env, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => getConfig({ ...env, ADMIN_API_KEY: '' })).toThrow(/ADMIN_API_KEY/);
    expect(() => getConfig({ ...env, MEDIA_SIGNING_SECRET: undefined as never })).toThrow(
      /MEDIA_SIGNING_SECRET/,
    );
  });
  it('refuses to run production with the simulate endpoints on', () => {
    expect(() => getConfig({ ...env, ENVIRONMENT: 'production', SIMULATE_ENABLED: 'true' })).toThrow(
      /SIMULATE_ENABLED/,
    );
    expect(getConfig({ ...env, ENVIRONMENT: 'production', SIMULATE_ENABLED: 'false' }).isProduction).toBe(
      true,
    );
  });
  it('splits comma separated lists', () => {
    const c = getConfig({ ...env, GOOGLE_CLIENT_IDS: ' a.apps , b.apps ,', CORS_ORIGINS: 'https://x.test' });
    expect(c.GOOGLE_CLIENT_IDS).toEqual(['a.apps', 'b.apps']);
    expect(c.CORS_ORIGINS).toEqual(['https://x.test']);
  });
});

describe('OpenAPI document', () => {
  it('describes every operation well enough to generate a client from', async () => {
    const { request } = makeApp();
    const doc = await body(await request('/v1/openapi.json'));
    const operations: { method: string; path: string; op: any }[] = [];
    for (const [path, item] of Object.entries<any>(doc.paths)) {
      for (const method of ['get', 'put', 'post', 'patch', 'delete'])
        if (item[method]) operations.push({ method, path, op: item[method] });
    }
    expect(operations.length).toBeGreaterThanOrEqual(76); // a route lost by mistake would show up here
    const problems: string[] = [];
    for (const { method, path, op } of operations) {
      const id = `${method.toUpperCase()} ${path}`;
      if (!op.summary) problems.push(`${id}: no summary`);
      if (!op.tags?.length) problems.push(`${id}: no tag`);
      if (!Object.keys(op.responses ?? {}).some((c) => c.startsWith('2')))
        problems.push(`${id}: no success response`);
      const needsAuth =
        !path.startsWith('/v1/health') &&
        path !== '/v1/config' &&
        !path.startsWith('/v1/auth/') &&
        !path.endsWith('/file') &&
        !path.startsWith('/v1/webhooks');
      if (needsAuth && !op.security?.length) problems.push(`${id}: not marked as needing authentication`);
    }
    expect(problems).toEqual([]);
    expect(new Set(operations.map((o) => o.op.tags[0]))).toEqual(
      new Set([
        'Health',
        'Config',
        'Auth',
        'Me',
        'Weight',
        'Water',
        'Diary',
        'Foods',
        'Scans',
        'Sync',
        'Subscription',
        'Media',
        'Workouts',
        'Training',
        'Admin',
        'Account',
        'AI',
        'Insights',
      ]),
    );
  });
  it('registers the shared schemas once, by name', async () => {
    const { request } = makeApp();
    const schemas = Object.keys((await body(await request('/v1/openapi.json'))).components.schemas);
    expect(schemas).toEqual(
      expect.arrayContaining([
        'ErrorBody',
        'Session',
        'DiaryEntry',
        'Entitlement',
        'SyncPullResult',
        'ProgramDetail',
        'WeeklyInsights',
      ]),
    );
  });
});
