import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminClient } from '../../../test/helpers/content';
import { MemoryMailer } from '../../../test/helpers/mailer';
import { T0, body, jsonInit, makeApp, signUp } from '../../../test/helpers/app';
import { FakeAi } from '../../../test/helpers/ai';
import { PLANS } from '../../config/plans';
import { integrityMock } from '../integrity/integrity';
import { clearSettingsCache } from './settings.service';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM app_settings');
});

const setup = () => {
  const t = makeApp({ mailer: new MemoryMailer(), ai: new FakeAi() });
  const admin = adminClient(t);
  const config = (version?: string) =>
    t.request('/v1/config', { headers: version ? { 'x-app-version': version } : {} });
  return { t, admin, config };
};

describe('GET /config', () => {
  it('needs no sign-in and describes the deployment', async () => {
    const { config } = setup();
    const res = await config('1.0.0');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=30');
    const c = await body(res);
    expect(c).toMatchObject({
      apiVersion: 'v1',
      serverTime: T0,
      maintenance: { enabled: false },
      update: 'none',
      minAppVersion: '0.0.0',
      features: { aiText: true, emailSignIn: true, workouts: true, scanContributions: true },
      signIn: { google: false, email: true },
      integrity: { required: false },
      testPurchases: true, // the test configuration allows simulated purchases
      urls: { store: null, privacy: null, terms: null, supportEmail: null },
    });
    expect(c.plans.free.limits).toEqual(PLANS.free.limits);
    expect(c.plans.pro.features.workouts).toBe('all');
  });
  it('says the version is unknown when the app does not send one', async () => {
    const { config } = setup();
    expect((await body(await config())).update).toBe('unknown');
    expect((await body(await config('garbage'))).update).toBe('unknown');
  });
  it('reports whether the integrity check is required', async () => {
    const t = makeApp({ integrity: integrityMock });
    expect((await body(await t.request('/v1/config'))).integrity.required).toBe(true);
  });
});

describe('admin settings', () => {
  it('need the admin key', async () => {
    const { t } = setup();
    expect((await t.request('/v1/admin/settings')).status).toBe(401);
    expect((await t.request('/v1/admin/settings', jsonInit('PUT', { minAppVersion: '1.0.0' }))).status).toBe(
      401,
    );
  });
  it('start from the deploy’s values', async () => {
    const { admin } = setup();
    expect(await body(await admin.call('GET', '/v1/admin/settings'))).toEqual({
      maintenance: { enabled: false, message: 'We are making improvements and will be back shortly.' },
      minAppVersion: '0.0.0',
      latestAppVersion: '0.0.0',
      disabledFeatures: [],
    });
  });
  it('change at once, store canonical versions, and can be cleared again', async () => {
    const { admin, config } = setup();
    const put = await admin.call('PUT', '/v1/admin/settings', {
      minAppVersion: '1.4',
      latestAppVersion: '2.0.1',
      disabledFeatures: ['workouts', 'aiText', 'workouts'],
      maintenance: { enabled: false, message: 'Back at 9' },
    });
    expect(await body(put)).toEqual({
      maintenance: { enabled: false, message: 'Back at 9' },
      minAppVersion: '1.4.0',
      latestAppVersion: '2.0.1',
      disabledFeatures: ['aiText', 'workouts'],
    });
    const c = await body(await config('1.9.0'));
    expect(c).toMatchObject({
      update: 'available',
      features: { aiText: false, workouts: false, emailSignIn: true },
    });

    await admin.call('PUT', '/v1/admin/settings', {
      minAppVersion: null,
      latestAppVersion: null,
      disabledFeatures: null,
      maintenance: null,
    });
    expect(await body(await admin.call('GET', '/v1/admin/settings'))).toMatchObject({
      minAppVersion: '0.0.0',
      disabledFeatures: [],
      maintenance: { enabled: false },
    });
  });
  it('change only the fields that are sent', async () => {
    const { admin } = setup();
    await admin.call('PUT', '/v1/admin/settings', { minAppVersion: '1.2.0' });
    await admin.call('PUT', '/v1/admin/settings', { latestAppVersion: '1.3.0' });
    expect(await body(await admin.call('GET', '/v1/admin/settings'))).toMatchObject({
      minAppVersion: '1.2.0',
      latestAppVersion: '1.3.0',
    });
  });
  it('reject bad input, including unknown fields and features', async () => {
    const { admin } = setup();
    for (const bad of [
      { minAppVersion: 'latest' },
      { minAppVersion: '1' },
      { disabledFeatures: ['nonsense'] },
      { maintenance: { enabled: 'yes' } },
      { maintenance: { enabled: true, message: 'x'.repeat(301) } },
      { surprise: true },
    ])
      expect((await admin.call('PUT', '/v1/admin/settings', bad)).status).toBe(422);
  });
});

describe('maintenance mode', () => {
  it('turns every API call into 503 with Retry-After, except the ones the app needs to see why', async () => {
    const { t, admin, config } = setup();
    const s = await signUp(t);
    await admin.call('PUT', '/v1/admin/settings', { maintenance: { enabled: true, message: 'Back at 9' } });
    for (const [method, path] of [
      ['GET', '/v1/me'],
      ['POST', '/v1/auth/anonymous'],
      ['POST', '/v1/auth/refresh'],
      ['GET', '/v1/foods/search?q=rice'],
      ['GET', '/v1/nope'],
    ] as const) {
      const res = await t.request(path, jsonInit(method, method === 'POST' ? {} : undefined, s.accessToken));
      expect(res.status, path).toBe(503);
      expect(res.headers.get('retry-after'), path).toBe('60');
      expect((await body(res)).error).toMatchObject({ code: 'maintenance', message: 'Back at 9' });
    }
    expect((await t.request('/v1/health')).status).toBe(200);
    expect((await t.request('/v1/openapi.json')).status).toBe(200);
    expect((await admin.call('GET', '/v1/admin/settings')).status).toBe(200);
    const c = await body(await config());
    expect(c.maintenance).toEqual({ enabled: true, message: 'Back at 9' });

    await admin.call('PUT', '/v1/admin/settings', { maintenance: { enabled: false } });
    expect((await t.request('/v1/me', jsonInit('GET', undefined, s.accessToken))).status).toBe(200);
  });
  it('can start from the deploy’s variable, and the admin switch wins over it', async () => {
    const t = makeApp();
    const deploy = { ...env, MAINTENANCE_MODE: 'true', MAINTENANCE_MESSAGE: 'Planned work' };
    const res = await t.app.request('/v1/me', undefined, deploy);
    expect(res.status).toBe(503);
    expect((await body(res)).error.message).toBe('Planned work');
    await adminClient(t).call('PUT', '/v1/admin/settings', { maintenance: { enabled: false } });
    expect((await t.app.request('/v1/me', undefined, deploy)).status).toBe(401); // reaches auth: the gate let it through
  });
  it('does not take the API down if the settings cannot be read', async () => {
    const t = makeApp();
    const broken = {
      ...env,
      DB: new Proxy(env.DB, {
        get(target, prop) {
          if (prop === 'prepare')
            return (sql: string) => {
              if (sql.includes('app_settings')) throw new Error('settings table unavailable');
              return target.prepare(sql);
            };
          const v = Reflect.get(target, prop) as unknown;
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }),
    };
    clearSettingsCache();
    const res = await t.app.request('/v1/auth/anonymous', jsonInit('POST', {}), broken);
    expect(res.status).toBe(201);
  });
});

describe('minimum app version', () => {
  it('turns old versions away with 426 and where to update, and lets current and unlabelled ones in', async () => {
    const { t, admin } = setup();
    const withStore = { ...env, STORE_URL: 'https://play.google.com/store/apps/details?id=za.co.example' };
    await admin.call('PUT', '/v1/admin/settings', { minAppVersion: '1.4.0' });
    const call = (version?: string) =>
      t.app.request(
        '/v1/auth/anonymous',
        jsonInit('POST', {}, undefined, version ? { 'x-app-version': version } : {}),
        withStore,
      );
    const old = await call('1.3.9');
    expect(old.status).toBe(426);
    expect((await body(old)).error).toMatchObject({
      code: 'upgrade_required',
      details: {
        minAppVersion: '1.4.0',
        storeUrl: 'https://play.google.com/store/apps/details?id=za.co.example',
      },
    });
    expect((await call('1.4.0')).status).toBe(201);
    expect((await call('2.0.0 (build 5)')).status).toBe(201);
    expect((await call()).status).toBe(201);
    expect((await call('not-a-version')).status).toBe(201);
    expect(
      (await body(await t.request('/v1/config', { headers: { 'x-app-version': '1.3.9' } }))).update,
    ).toBe('required');
    expect((await t.request('/v1/config', { headers: { 'x-app-version': '1.3.9' } })).status).toBe(200); // config still answers
  });
});

describe('feature kill switches', () => {
  it('stop the AI and email sign-in while switched off, and nothing else', async () => {
    const { t, admin } = setup();
    const s = await signUp(t);
    await admin.call('PUT', '/v1/admin/settings', { disabledFeatures: ['aiText', 'emailSignIn'] });
    const ai = await t.request('/v1/ai/parse-meal', jsonInit('POST', { text: 'toast' }, s.accessToken));
    expect(ai.status).toBe(503);
    expect(ai.headers.get('retry-after')).toBe('300');
    expect((await body(ai)).error).toMatchObject({
      code: 'feature_disabled',
      details: { feature: 'aiText' },
    });
    expect(
      (await t.request('/v1/auth/email/start', jsonInit('POST', { email: 'a@example.com' }))).status,
    ).toBe(503);
    expect(
      (await t.request('/v1/auth/email/verify', jsonInit('POST', { email: 'a@example.com', code: '123456' })))
        .status,
    ).toBe(503);
    expect((await t.request('/v1/me', jsonInit('GET', undefined, s.accessToken))).status).toBe(200);
    expect((await body(await t.request('/v1/config'))).signIn.email).toBe(false);

    await admin.call('PUT', '/v1/admin/settings', { disabledFeatures: [] });
    expect(
      (await t.request('/v1/auth/email/start', jsonInit('POST', { email: 'a@example.com' }))).status,
    ).toBe(202);
  });
});

describe('security headers', () => {
  it('lock down every response, including errors', async () => {
    const { t } = setup();
    for (const path of ['/v1/health', '/v1/nope', '/v1/me']) {
      const res = await t.request(path);
      expect(res.headers.get('content-security-policy'), path).toContain("default-src 'none'");
      expect(res.headers.get('content-security-policy'), path).toContain("frame-ancestors 'none'");
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(res.headers.get('referrer-policy'), path).toBe('no-referrer');
      expect(res.headers.get('strict-transport-security'), path).toContain('max-age=63072000');
      expect(res.headers.get('cross-origin-resource-policy'), path).toBe('same-site');
      expect(res.headers.get('permissions-policy'), path).toContain('camera=()');
    }
    expect((await t.request('/v1/me')).headers.get('cache-control')).toBe('no-store');
  });
});
