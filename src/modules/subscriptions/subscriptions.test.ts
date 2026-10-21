import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { newId } from '../../core/ids';
import { DAY, HOUR } from '../../core/time';
import { T0, authed, body, jsonInit, makeApp, signUp } from '../../../test/helpers/app';
import { requirePro } from '../../middleware/entitlements';
import { requireAuth } from '../../middleware/auth';
import { PLANS } from '../../config/plans';

/** Routes that exist only in tests, to exercise the quota and Pro-gate helpers that no real route uses yet. */
function testRoutes(app: ReturnType<typeof makeApp>['app']) {
  app.post('/v1/test/ai', requireAuth, async (c) =>
    c.json(await c.get('deps').subscriptions.consume(c.get('auth')!.userId, 'ai_text')),
  );
  app.get('/v1/test/pro-only', requireAuth, requirePro('Workouts'), (c) => c.json({ ok: true }));
}

async function setup(overrides: Parameters<typeof makeApp>[0] = {}) {
  const t = makeApp(overrides, testRoutes);
  const s = await signUp(t);
  const session = { token: s.accessToken, refresh: s.refreshToken };
  const send = (method: string, path: string, data?: unknown, token = session.token) =>
    t.request(path, jsonInit(method, data, token));
  const verify = (token: string, productId = 'pro_monthly', as = session.token) =>
    send('POST', '/v1/subscription/verify', { productId, purchaseToken: token }, as);
  const ent = async (as = session.token) => body(await send('GET', '/v1/entitlements', undefined, as));
  /** After the test moves the clock, the 15 minute access token is stale: swap the refresh token for a new one. */
  const relogin = async () => {
    const next = await body(
      await t.request('/v1/auth/refresh', jsonInit('POST', { refreshToken: session.refresh })),
    );
    session.token = next.accessToken;
    session.refresh = next.refreshToken;
  };
  return { t, s, send, verify, ent, relogin };
}

describe('entitlements for a new account', () => {
  it('are the free plan, with the limits and no usage', async () => {
    const { ent } = await setup();
    expect(await ent()).toMatchObject({
      plan: 'free',
      status: 'none',
      expiresAt: null,
      willRenew: false,
      inGrace: false,
      isTrial: false,
      limits: PLANS.free.limits,
      features: PLANS.free.features,
      usage: { date: '2026-10-21', scans: 0, aiText: 0 },
    }); // fmt: skip
  });
  it('need sign-in', async () => {
    const { t } = await setup();
    expect((await t.request('/v1/entitlements')).status).toBe(401);
    expect((await t.request('/v1/subscription')).status).toBe(401);
  });
  it('list the products on sale', async () => {
    const { send } = await setup();
    const b = await body(await send('GET', '/v1/subscription'));
    expect(b.subscription).toBeNull();
    expect(b.products.map((p: { id: string }) => p.id)).toEqual(['pro_monthly', 'pro_yearly']);
  });
});

describe('verifying a purchase (mock store)', () => {
  it.each([
    ['active', 'pro', 'active'],
    ['trial', 'pro', 'trialing'],
    ['canceled', 'pro', 'canceled'],
    ['grace', 'pro', 'in_grace'],
    ['hold', 'free', 'on_hold'],
    ['expired', 'free', 'expired'],
    ['refunded', 'free', 'refunded'],
  ])('a %s purchase leaves the account on %s (status %s)', async (state, plan, status) => {
    const { verify, ent } = await setup();
    const res = await verify(`mock_pro_monthly_${state}`);
    expect(res.status).toBe(200);
    expect(await ent()).toMatchObject({ plan, status });
    expect((await body(res)).subscription).toMatchObject({
      provider: 'mock',
      status,
      productId: 'pro_monthly',
    });
  });
  it('is idempotent', async () => {
    const { verify, send, s } = await setup();
    await verify('mock_pro_monthly_active_a1');
    await verify('mock_pro_monthly_active_a1');
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?')
      .bind(s.userId)
      .first<{ n: number }>();
    expect(n!.n).toBe(1);
    expect((await body(await send('GET', '/v1/subscription'))).entitlement.plan).toBe('pro');
  });
  it('gives the yearly plan a year', async () => {
    const { verify, ent } = await setup();
    await verify('mock_pro_yearly_active', 'pro_yearly');
    const e = await ent();
    expect(e.expiresAt).toBe(T0 - 5 * DAY + 365 * DAY);
  });
  it('rejects tokens the store does not know, mismatched products and bad input', async () => {
    const { verify } = await setup();
    const unknown = await verify('mock_pro_monthly_banana');
    expect(unknown.status).toBe(400);
    expect((await body(unknown)).error.details.reason).toBe('purchase_not_found');
    expect((await verify('mock_pro_monthly_active', 'pro_yearly')).status).toBe(400);
    expect((await verify('short')).status).toBe(422);
    expect((await verify('x'.repeat(5000))).status).toBe(422);
  });
  it('will not attach one purchase to two accounts', async () => {
    const { t, verify, ent } = await setup();
    await verify('mock_pro_monthly_active_shared');
    const other = await signUp(t);
    const res = await verify('mock_pro_monthly_active_shared', 'pro_monthly', other.accessToken);
    expect(res.status).toBe(409);
    expect((await body(res)).error.details.reason).toBe('purchase_belongs_to_another_account');
    expect((await ent(other.accessToken)).plan).toBe('free');
    expect((await ent()).plan).toBe('pro');
  });
  it('lets the same account hold several purchases and uses the best one', async () => {
    const { verify, ent } = await setup();
    await verify('mock_pro_monthly_expired_a');
    expect((await ent()).plan).toBe('free');
    await verify('mock_pro_monthly_active_b');
    expect((await ent()).plan).toBe('pro');
  });
  it('stops granting access as time passes', async () => {
    const { t, verify, ent, relogin } = await setup();
    await verify('mock_pro_monthly_active_c'); // ends 25 days from now
    t.clock.advance(24 * DAY);
    await relogin();
    expect((await ent()).plan).toBe('pro');
    t.clock.advance(2 * DAY);
    await relogin();
    expect(await ent()).toMatchObject({ plan: 'free', status: 'active' }); // never renewed: the app should offer to resubscribe
    void HOUR;
  });
});

describe('simulation (stage and local)', () => {
  it('walks a subscription through its life', async () => {
    const { send, ent } = await setup();
    const sim = (scenario: string, productId?: string) =>
      send('POST', '/v1/subscription/simulate', { scenario, productId });
    expect((await sim('cancel')).status).toBe(400); // nothing to cancel yet
    expect((await sim('subscribe')).status).toBe(200);
    expect(await ent()).toMatchObject({ plan: 'pro', status: 'active', willRenew: true });
    await sim('cancel');
    expect(await ent()).toMatchObject({ plan: 'pro', status: 'canceled', willRenew: false });
    await sim('renew');
    expect(await ent()).toMatchObject({ plan: 'pro', status: 'active', willRenew: true });
    await sim('grace');
    expect(await ent()).toMatchObject({ plan: 'pro', inGrace: true });
    await sim('hold');
    expect(await ent()).toMatchObject({ plan: 'free', status: 'on_hold' });
    await sim('renew');
    await sim('expire');
    expect(await ent()).toMatchObject({ plan: 'free', status: 'expired' });
    await sim('renew');
    await sim('refund');
    expect(await ent()).toMatchObject({ plan: 'free', status: 'refunded' });
  });
  it('can start the yearly product', async () => {
    const { send, ent } = await setup();
    await send('POST', '/v1/subscription/simulate', { scenario: 'subscribe', productId: 'pro_yearly' });
    expect((await ent()).expiresAt).toBe(T0 + 365 * DAY - 5 * DAY);
    expect(
      (await send('POST', '/v1/subscription/simulate', { scenario: 'subscribe', productId: 'pro_weekly' }))
        .status,
    ).toBe(422);
    expect((await send('POST', '/v1/subscription/simulate', { scenario: 'teleport' })).status).toBe(422);
  });
  it('is off when switched off', async () => {
    const t = makeApp();
    const s = await signUp(t);
    const off = { ...env, SIMULATE_ENABLED: 'false' };
    const res = await t.app.request(
      '/v1/subscription/simulate',
      jsonInit('POST', { scenario: 'subscribe' }, s.accessToken),
      off,
    );
    expect(res.status).toBe(404);
  });
});

describe('production safety', () => {
  const prod = { ...env, ENVIRONMENT: 'production', SIMULATE_ENABLED: 'false' };
  it('does not honour pretend purchases, so nobody can type their way to Pro', async () => {
    const t = makeApp();
    const s = await signUp(t);
    const res = await t.app.request(
      '/v1/subscription/verify',
      jsonInit('POST', { productId: 'pro_monthly', purchaseToken: 'mock_pro_monthly_active' }, s.accessToken),
      prod,
    );
    expect(res.status).toBe(501);
    expect((await body(res)).error.code).toBe('not_configured');
    const restore = await t.app.request(
      '/v1/subscription/restore',
      jsonInit('POST', undefined, s.accessToken),
      prod,
    );
    expect(restore.status).toBe(501);
    const sim = await t.app.request(
      '/v1/subscription/simulate',
      jsonInit('POST', { scenario: 'subscribe' }, s.accessToken),
      prod,
    );
    expect(sim.status).toBe(404);
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?')
      .bind(s.userId)
      .first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });
  it('says Google Play is not set up yet', async () => {
    const t = makeApp();
    const s = await signUp(t);
    const gp = { ...env, BILLING_PROVIDER: 'google_play' };
    const res = await t.app.request(
      '/v1/subscription/verify',
      jsonInit('POST', { productId: 'pro_monthly', purchaseToken: 'a'.repeat(40) }, s.accessToken),
      gp,
    );
    expect(res.status).toBe(501);
    expect((await t.app.request('/v1/webhooks/google-play', jsonInit('POST', {}), env)).status).toBe(501);
  });
});

describe('restore purchases', () => {
  it('returns the current state (the pretend store has nothing to re-read)', async () => {
    const { send, verify } = await setup();
    await verify('mock_pro_monthly_active_r');
    const res = await send('POST', '/v1/subscription/restore');
    expect(res.status).toBe(200);
    expect((await body(res)).entitlement.plan).toBe('pro');
  });
});

describe('daily allowances', () => {
  it('stop at the plan limit and cannot be raced past it', async () => {
    const { t, send } = await setup();
    const results = await Promise.all(Array.from({ length: 12 }, () => send('POST', '/v1/test/ai')));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(PLANS.free.limits.aiTextPerDay);
    expect(statuses.filter((s) => s === 429)).toHaveLength(12 - PLANS.free.limits.aiTextPerDay);
    const blocked = results.find((r) => r.status === 429)!;
    expect((await body(blocked)).error).toMatchObject({
      code: 'quota_exceeded',
      details: { key: 'ai_text', limit: 5 },
    });
  });
  it('reset the next day and follow the person’s own timezone', async () => {
    const { t, send, ent, relogin } = await setup();
    await send('PATCH', '/v1/me/profile', { timezone: 'Africa/Johannesburg' });
    for (let i = 0; i < 5; i++) await send('POST', '/v1/test/ai');
    expect((await send('POST', '/v1/test/ai')).status).toBe(429);
    expect((await ent()).usage).toEqual({ date: '2026-10-21', scans: 0, aiText: 5 });
    t.clock.advance(10 * HOUR); // 22:00 UTC = midnight in Johannesburg: a new local day
    await relogin();
    expect((await send('POST', '/v1/test/ai')).status).toBe(200);
    expect((await ent()).usage).toEqual({ date: '2026-10-22', scans: 0, aiText: 1 });
  });
  it('are bigger on Pro', async () => {
    const { t, send, verify } = await setup();
    await verify('mock_pro_monthly_active_big');
    let ok = 0;
    for (let i = 0; i < 8; i++) if ((await send('POST', '/v1/test/ai')).status === 200) ok++;
    expect(ok).toBe(8);
  });
  it('gate Pro-only features', async () => {
    const { t, send, verify } = await setup();
    const denied = await send('GET', '/v1/test/pro-only');
    expect(denied.status).toBe(402);
    expect((await body(denied)).error).toMatchObject({
      code: 'subscription_required',
      details: { feature: 'Workouts' },
    });
    await verify('mock_pro_monthly_active_gate');
    expect((await send('GET', '/v1/test/pro-only')).status).toBe(200);
    expect((await t.request('/v1/test/pro-only')).status).toBe(401);
  });
  it('count scans for the app to show, without ever refusing one', async () => {
    const { send, ent } = await setup();
    const scan = {
      modelVersion: 'nutrition_v1',
      outcome: 'saved',
      contributeConsent: false,
      clientCreatedAt: T0,
    };
    for (let i = 0; i < 5; i++) expect((await send('PUT', `/v1/scans/${newId()}`, scan)).status).toBe(200);
    const repeated = newId();
    await send('PUT', `/v1/scans/${repeated}`, scan);
    await send('PUT', `/v1/scans/${repeated}`, { ...scan, outcome: 'edited' }); // an edit is not a new scan
    expect((await ent()).usage.scans).toBe(6);
    expect((await ent()).limits.scansPerDay).toBe(PLANS.free.limits.scansPerDay);
  });
});

describe('meal photo allowance', () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  async function entryWithPhoto(t: ReturnType<typeof makeApp>, token: string) {
    const id = newId();
    await t.request(
      `/v1/diary/entries/${id}`,
      jsonInit(
        'PUT',
        {
          loggedAt: T0,
          localDate: '2026-10-21',
          mealType: 'lunch',
          name: 'x',
          calories: 1,
          source: 'manual',
          clientUpdatedAt: T0,
        },
        token,
      ),
    );
    return id;
  }
  it('stops free accounts at the limit, but never blocks replacing an existing photo, and Pro is unlimited', async () => {
    const { t, s, verify } = await setup();
    const upload = (id: string) =>
      t.request(`/v1/diary/entries/${id}/photo`, {
        method: 'PUT',
        headers: { 'content-type': 'image/jpeg', ...authed(s.accessToken) },
        body: jpeg as BodyInit,
      });
    const limit = PLANS.free.limits.mealPhotos;
    const first = await entryWithPhoto(t, s.accessToken);
    expect((await upload(first)).status).toBe(200);
    // fill the rest of the allowance directly, to keep the test fast
    for (let i = 1; i < limit; i++) {
      const id = await entryWithPhoto(t, s.accessToken);
      await env.DB.prepare('UPDATE diary_entries SET photo_key = ? WHERE id = ?')
        .bind(`fake/${id}`, id)
        .run();
    }
    const over = await entryWithPhoto(t, s.accessToken);
    const blocked = await upload(over);
    expect(blocked.status).toBe(429);
    expect((await body(blocked)).error).toMatchObject({
      code: 'quota_exceeded',
      details: { key: 'meal_photos', limit },
    });
    expect((await upload(first)).status).toBe(200); // replacing one you already have is fine
    await verify('mock_pro_monthly_active_photos');
    expect((await upload(over)).status).toBe(200);
  });
});
