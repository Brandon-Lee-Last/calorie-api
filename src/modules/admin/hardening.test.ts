import { env } from 'cloudflare:workers';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminClient } from '../../../test/helpers/content';
import { T0, body, jsonInit, makeApp, signUp } from '../../../test/helpers/app';
import { CloudflareAccessVerifier } from '../../core/cloudflare-access';
import { D1RateLimiter } from '../../core/rate-limiter';
import { DAY, FakeClock } from '../../core/time';
import { getConfig } from '../../env';
import type { Alert } from '../../core/alerts';
import { AUDIT_RETENTION_MS } from './audit.service';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM admin_audit');
  await env.DB.exec('DELETE FROM rate_limits');
});

const KEY = () => env.ADMIN_API_KEY;
const get = (t: ReturnType<typeof makeApp>, headers: Record<string, string>, e: object = env) =>
  t.app.request('/v1/admin/settings', { headers }, e);

describe('IP allowlist', () => {
  const locked = { ...env, ADMIN_ALLOWED_IPS: '198.51.100.0/24, 203.0.113.7' };
  it('lets listed addresses and ranges in, and turns every other address away', async () => {
    const t = makeApp();
    const hdr = (ip?: string) => ({ 'x-admin-key': KEY(), ...(ip ? { 'cf-connecting-ip': ip } : {}) });
    expect((await get(t, hdr('198.51.100.20'), locked)).status).toBe(200);
    expect((await get(t, hdr('203.0.113.7'), locked)).status).toBe(200);
    for (const ip of ['203.0.113.8', '8.8.8.8', undefined]) {
      const res = await get(t, hdr(ip), locked);
      expect(res.status, String(ip)).toBe(403);
      expect((await body(res)).error.code).toBe('forbidden');
    }
    expect((await get(t, hdr('8.8.8.8'))).status).toBe(200); // no allowlist: anywhere
  });
  it('is checked before the key, so a stranger learns nothing about whether the key is right', async () => {
    const t = makeApp();
    const bad = await get(t, { 'x-admin-key': 'wrong', 'cf-connecting-ip': '8.8.8.8' }, locked);
    const good = await get(t, { 'x-admin-key': KEY(), 'cf-connecting-ip': '8.8.8.8' }, locked);
    expect(bad.status).toBe(403);
    expect(good.status).toBe(403);
  });
  it('is rejected at startup if an entry is not an address', () => {
    expect(() => getConfig({ ...env, ADMIN_ALLOWED_IPS: '203.0.113.7, banana' })).toThrow(
      /ADMIN_ALLOWED_IPS/,
    );
  });
});

describe('Cloudflare Access', () => {
  async function access() {
    const clock = new FakeClock(T0);
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k', alg: 'RS256', use: 'sig' };
    const team = 'team.cloudflareaccess.com';
    const aud = 'b'.repeat(64);
    const accessVerifier = new CloudflareAccessVerifier(team, aud, clock, createLocalJWKSet({ keys: [jwk] }));
    const assertion = (email: string) =>
      new SignJWT({ email })
        .setProtectedHeader({ alg: 'RS256', kid: 'k' })
        .setIssuer(`https://${team}`)
        .setAudience(aud)
        .setIssuedAt(Math.floor(T0 / 1000))
        .setExpirationTime(Math.floor(T0 / 1000) + 300)
        .sign(privateKey);
    return { clock, accessVerifier, assertion };
  }
  it('is required on top of the admin key once it is set up, and names who is calling', async () => {
    const { clock, accessVerifier, assertion } = await access();
    const t = makeApp({ clock, accessVerifier });
    const withKey = { 'x-admin-key': KEY() };
    expect((await get(t, withKey)).status).toBe(403); // a leaked key alone is not enough
    expect((await get(t, { ...withKey, 'cf-access-jwt-assertion': 'forged' })).status).toBe(403);
    const ok = await get(t, { ...withKey, 'cf-access-jwt-assertion': await assertion('boss@example.com') });
    expect(ok.status).toBe(200);
    // and a valid Access login still needs the key
    expect((await get(t, { 'cf-access-jwt-assertion': await assertion('boss@example.com') })).status).toBe(
      401,
    );

    const audit = await body(
      await t.request('/v1/admin/audit', {
        headers: { ...withKey, 'cf-access-jwt-assertion': await assertion('boss@example.com') },
      }),
    );
    expect(audit.items.map((i: any) => [i.actor, i.status])).toContainEqual(['boss@example.com', 200]);
    expect(audit.items.map((i: any) => [i.actor, i.status])).toContainEqual(['boss@example.com', 401]);
  });
  it('must be configured as a pair', () => {
    expect(() => getConfig({ ...env, CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com' })).toThrow(
      /together/,
    );
    expect(() => getConfig({ ...env, CF_ACCESS_AUD: 'c'.repeat(32) })).toThrow(/together/);
    expect(() =>
      getConfig({ ...env, CF_ACCESS_TEAM_DOMAIN: 'not a host', CF_ACCESS_AUD: 'c'.repeat(32) }),
    ).toThrow(/CF_ACCESS_TEAM_DOMAIN/);
    expect(
      getConfig({ ...env, CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'c'.repeat(32) })
        .CF_ACCESS_AUD,
    ).toBeDefined();
  });
  it('builds the real verifier from the two settings', async () => {
    const t = makeApp();
    const configured = {
      ...env,
      CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      CF_ACCESS_AUD: 'c'.repeat(32),
    };
    // the real verifier would fetch Google's... Cloudflare's keys; without an assertion it refuses before any network call
    expect((await get(t, { 'x-admin-key': KEY() }, configured)).status).toBe(403);
  });
});

describe('locking out key guessing', () => {
  it('locks an address out after ten wrong keys, even for the right key, and only that address', async () => {
    const clock = new FakeClock(T0);
    const t = makeApp({ clock, strictLimiter: new D1RateLimiter(env.DB, clock) });
    const ip = { 'cf-connecting-ip': '192.0.2.50' };
    for (let i = 0; i < 10; i++)
      expect((await get(t, { ...ip, 'x-admin-key': `wrong-${i}` })).status).toBe(401);
    const locked = await get(t, { ...ip, 'x-admin-key': KEY() });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await get(t, { 'cf-connecting-ip': '192.0.2.51', 'x-admin-key': KEY() })).status).toBe(200);
    clock.advance(16 * 60_000);
    expect((await get(t, { ...ip, 'x-admin-key': KEY() })).status).toBe(200);
  });
  it('does not count successful calls', async () => {
    const clock = new FakeClock(T0);
    const t = makeApp({ clock, strictLimiter: new D1RateLimiter(env.DB, clock) });
    for (let i = 0; i < 15; i++) expect((await get(t, { 'x-admin-key': KEY() })).status).toBe(200);
  });
  it('rate limits admin calls overall', async () => {
    const clock = new FakeClock(T0);
    const t = makeApp({ clock, strictLimiter: new D1RateLimiter(env.DB, clock) });
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await get(t, { 'x-admin-key': KEY() })).status;
    expect(last).toBe(429);
  });
});

describe('audit log', () => {
  it('records successes, refusals and writes, with a hashed address and no query string', async () => {
    const t = makeApp();
    const admin = adminClient(t);
    await admin.call('PUT', '/v1/admin/settings', { minAppVersion: '1.0.0' });
    await get(t, { 'x-admin-key': 'wrong', 'cf-connecting-ip': '192.0.2.99' });
    await t.request('/v1/admin/audit?limit=5', { headers: { 'x-admin-key': KEY() } });
    const page = await body(await t.request('/v1/admin/audit', { headers: { 'x-admin-key': KEY() } }));
    const rows = page.items.map((i: any) => `${i.actor} ${i.method} ${i.path} ${i.status}`);
    expect(rows).toContain('api-key PUT /v1/admin/settings 200');
    expect(rows).toContain('anonymous GET /v1/admin/settings 401');
    expect(rows).toContain('api-key GET /v1/admin/audit 200');
    expect(rows.join()).not.toContain('limit=');
    const stored = JSON.stringify((await env.DB.prepare('SELECT * FROM admin_audit').all()).results);
    expect(stored).not.toContain('192.0.2.99');
    expect(page.items[0]).toMatchObject({ requestId: expect.any(String) });
  });
  it('pages newest first', async () => {
    const t = makeApp();
    for (let i = 0; i < 5; i++) await adminClient(t).call('GET', '/v1/admin/settings');
    const first = await body(
      await t.request('/v1/admin/audit?limit=2', { headers: { 'x-admin-key': KEY() } }),
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await body(
      await t.request(`/v1/admin/audit?limit=2&cursor=${first.nextCursor}`, {
        headers: { 'x-admin-key': KEY() },
      }),
    );
    expect(second.items).toHaveLength(2);
    expect(second.items[0].id < first.items[1].id).toBe(true);
    expect(
      (await t.request('/v1/admin/audit?cursor=garbage', { headers: { 'x-admin-key': KEY() } })).status,
    ).toBe(400);
  });
  it('needs the admin key', async () => {
    expect((await makeApp().request('/v1/admin/audit')).status).toBe(401);
  });
  it('does not fail the admin request if the audit write fails', async () => {
    const t = makeApp();
    await env.DB.exec('ALTER TABLE admin_audit RENAME TO admin_audit_gone');
    try {
      expect((await adminClient(t).call('GET', '/v1/admin/settings')).status).toBe(200);
    } finally {
      await env.DB.exec('ALTER TABLE admin_audit_gone RENAME TO admin_audit');
    }
  });
  it('is trimmed by the nightly maintenance after six months', async () => {
    const t = makeApp();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO admin_audit VALUES ('old', ?, 'x', 'GET', '/', 200, 'h', 'r')").bind(
        T0 - AUDIT_RETENTION_MS - DAY,
      ),
      env.DB.prepare("INSERT INTO admin_audit VALUES ('new', ?, 'x', 'GET', '/', 200, 'h', 'r')").bind(
        T0 - DAY,
      ),
    ]);
    expect(
      (await body(await adminClient(t).call('POST', '/v1/admin/maintenance/run'))).adminAuditRemoved,
    ).toBe(1);
  });
});

describe('JWT secret rotation, end to end', () => {
  it('keeps people signed in through a rotation', async () => {
    const t = makeApp();
    const s = await signUp(t); // signed with the original secret
    const rotated = {
      ...env,
      JWT_SECRET: 'rotated-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
      JWT_SECRET_PREVIOUS: env.JWT_SECRET,
    };
    const me = (e: object) => t.app.request('/v1/me', jsonInit('GET', undefined, s.accessToken), e);
    expect((await me(rotated)).status).toBe(200);
    expect((await me({ ...rotated, JWT_SECRET_PREVIOUS: undefined })).status).toBe(401);
    expect(() => getConfig({ ...env, JWT_SECRET_PREVIOUS: 'short' })).toThrow(/JWT_SECRET_PREVIOUS/);
  });
});

describe('error alerts', () => {
  function withAlerts() {
    const alerts: Alert[] = [];
    const alerter = { notify: async (a: Alert) => void alerts.push(a) };
    const t = makeApp({ alerter }, (app) => {
      app.get('/v1/test/boom', () => {
        throw new Error('database exploded for user 42');
      });
      app.get('/v1/test/forbidden', (c) => c.json({ ok: true }, 403));
    });
    return { t, alerts };
  }
  it('tells someone about an unexpected error, with the request id and no internal stack', async () => {
    const { t, alerts } = withAlerts();
    const res = await t.request('/v1/test/boom');
    expect(res.status).toBe(500);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.title).toBe('Unexpected error on GET /v1/test/boom');
    expect(alerts[0]!.detail).toContain('database exploded');
    expect(alerts[0]!.detail).toContain((await body(res)).error.requestId);
    expect(alerts[0]!.detail).not.toContain('at ');
  });
  it('stays quiet for errors that are the caller’s fault', async () => {
    const { t, alerts } = withAlerts();
    await t.request('/v1/me');
    await t.request('/v1/nope');
    await t.request('/v1/auth/refresh', jsonInit('POST', {}));
    expect(alerts).toHaveLength(0);
  });
  it('is switched on by ALERT_WEBHOOK_URL, and refuses non-https URLs', async () => {
    const posts: string[] = [];
    const fetcher = (async (url: string) => {
      posts.push(url);
      return new Response('ok');
    }) as unknown as typeof fetch;
    const t = makeApp({ fetcher }, (app) => {
      app.get('/v1/test/boom', () => {
        throw new Error('boom');
      });
    });
    const e = { ...env, ALERT_WEBHOOK_URL: 'https://hooks.example/alert' };
    expect((await t.app.request('/v1/test/boom', undefined, e)).status).toBe(500);
    expect(posts).toEqual(['https://hooks.example/alert']);
    expect(() => getConfig({ ...env, ALERT_WEBHOOK_URL: 'http://hooks.example/alert' })).toThrow(/https/);
  });
  it('is sent when the AI budget runs out', async () => {
    const { FakeAi, toastItem } = await import('../../../test/helpers/ai');
    const { linkAccount } = await import('../../../test/helpers/app');
    const alerts: Alert[] = [];
    const ai = new FakeAi();
    ai.jsonAnswer = { items: [toastItem] };
    const clock = new FakeClock(T0);
    const t = makeApp({
      ai,
      clock,
      strictLimiter: new D1RateLimiter(env.DB, clock),
      alerter: { notify: async (a) => void alerts.push(a) },
    });
    const s = await signUp(t);
    await linkAccount(s.userId);
    const call = () =>
      t.app.request('/v1/ai/parse-meal', jsonInit('POST', { text: 'toast' }, s.accessToken), {
        ...env,
        AI_DAILY_BUDGET: '0',
      });
    expect((await call()).status).toBe(503);
    expect(alerts.map((a) => a.key)).toEqual(['ai-budget']);
  });
});
