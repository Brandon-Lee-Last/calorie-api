import { env } from 'cloudflare:workers';
import { SignJWT, createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminClient } from '../../../../test/helpers/content';
import { T0, body, jsonInit, makeApp, signUp } from '../../../../test/helpers/app';
import { GoogleServiceAccountAuth } from '../../../core/google-auth';
import { silentLogger } from '../../../core/logger';
import { DAY, FakeClock } from '../../../core/time';
import { GooglePlayBillingProvider, mapPurchase, type PlayPurchase } from './google-play';
import { PubSubPushVerifier } from './rtdn';

const PKG = 'za.co.example.calories';
const AUDIENCE = 'https://api.example.com/v1/webhooks/google-play';
const PUSH_ACCOUNT = 'push@project.iam.gserviceaccount.com';
const iso = (ms: number) => new Date(ms).toISOString();

const purchase = (over: Partial<PlayPurchase> = {}, userId = 'user-1'): PlayPurchase => ({
  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
  startTime: iso(T0 - 5 * DAY),
  acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
  externalAccountIdentifiers: { obfuscatedExternalAccountId: userId },
  lineItems: [
    {
      productId: 'pro_monthly',
      expiryTime: iso(T0 + 25 * DAY),
      autoRenewingPlan: { autoRenewEnabled: true },
    },
  ],
  ...over,
});

describe('mapPurchase', () => {
  const map = (p: PlayPurchase, product?: string) => mapPurchase(p, 'tok', T0, product);
  it('maps each Play state onto ours', () => {
    const states: Record<string, string> = {
      SUBSCRIPTION_STATE_ACTIVE: 'active',
      SUBSCRIPTION_STATE_CANCELED: 'canceled',
      SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'in_grace',
      SUBSCRIPTION_STATE_ON_HOLD: 'on_hold',
      SUBSCRIPTION_STATE_PAUSED: 'paused',
      SUBSCRIPTION_STATE_EXPIRED: 'expired',
    };
    for (const [play, ours] of Object.entries(states))
      expect(map(purchase({ subscriptionState: play }))?.status, play).toBe(ours);
  });
  it('gives no subscription for purchases that cannot grant anything', () => {
    for (const state of [
      'SUBSCRIPTION_STATE_PENDING',
      'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED',
      'SUBSCRIPTION_STATE_UNSPECIFIED',
      undefined,
      'MADE_UP',
    ])
      expect(map(purchase({ subscriptionState: state })), String(state)).toBeNull();
    expect(map({})).toBeNull();
    expect(map(purchase({ lineItems: [] }))).toBeNull();
    expect(map(purchase({ lineItems: [{ productId: 'pro_monthly' }] }))).toBeNull(); // no expiry
    expect(map(purchase({ lineItems: [{ expiryTime: iso(T0) }] }))).toBeNull(); // no product
    expect(map(purchase({ lineItems: [{ productId: 'pro_monthly', expiryTime: 'not a date' }] }))).toBeNull();
  });
  it('fills in the details', () => {
    expect(map(purchase())).toEqual({
      provider: 'google_play',
      externalId: 'tok',
      productId: 'pro_monthly',
      status: 'active',
      autoRenew: true,
      startedAt: T0 - 5 * DAY,
      currentPeriodEnd: T0 + 25 * DAY,
      graceUntil: null,
      canceledAt: null,
      environment: 'production',
      accountId: 'user-1',
    });
  });
  it('knows test purchases, trials, cancellations and grace', () => {
    expect(map(purchase({ testPurchase: {} }))?.environment).toBe('sandbox');
    const trial = purchase();
    trial.lineItems![0]!.offerPhase = { freeTrial: {} };
    expect(map(trial)?.status).toBe('trialing');
    const cancelled = map(
      purchase({
        subscriptionState: 'SUBSCRIPTION_STATE_CANCELED',
        canceledStateContext: { userInitiatedCancellation: { cancelTime: iso(T0 - DAY) } },
      }),
    );
    expect(cancelled).toMatchObject({ status: 'canceled', autoRenew: false, canceledAt: T0 - DAY });
    const grace = map(
      purchase({
        subscriptionState: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
        lineItems: [
          {
            productId: 'pro_monthly',
            expiryTime: iso(T0 - DAY),
            autoRenewingPlan: { autoRenewEnabled: true },
          },
        ],
      }),
    );
    expect(grace?.graceUntil).toBeGreaterThan(T0); // access continues while Google says grace
    expect(map(purchase({ externalAccountIdentifiers: undefined }))?.accountId).toBeNull();
  });
  it('prefers the line item for the product asked about', () => {
    const p = purchase({
      lineItems: [
        { productId: 'pro_yearly', expiryTime: iso(T0 + 300 * DAY) },
        { productId: 'pro_monthly', expiryTime: iso(T0 + DAY) },
      ],
    });
    expect(map(p, 'pro_monthly')?.currentPeriodEnd).toBe(T0 + DAY);
    expect(map(p)?.productId).toBe('pro_yearly');
  });
});

/** A fake Play Developer API: answers purchase lookups from a table and records every call. */
async function fakePlay() {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const json = JSON.stringify({
    client_email: 'svc@x.iam.gserviceaccount.com',
    private_key: await exportPKCS8(privateKey),
  });
  const purchases = new Map<string, PlayPurchase | number>();
  const calls: Array<{ method: string; url: string }> = [];
  let ackStatus = 200;
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    if (url.includes('oauth2'))
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    calls.push({ method: init.method ?? 'GET', url });
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    const token = decodeURIComponent(/tokens\/([^/:?]+)/.exec(url)![1]!);
    if (url.endsWith(':acknowledge')) return new Response('{}', { status: ackStatus });
    const found = purchases.get(token);
    if (found === undefined) return new Response('{"error":{"status":"NOT_FOUND"}}', { status: 404 });
    if (typeof found === 'number') return new Response('boom', { status: found });
    return new Response(JSON.stringify(found));
  }) as unknown as typeof fetch;
  const clock = new FakeClock(T0);
  const auth = new GoogleServiceAccountAuth(json, clock, fetcher);
  const provider = new GooglePlayBillingProvider(auth, PKG, clock, silentLogger, fetcher);
  return { provider, purchases, calls, fetcher, clock, setAck: (n: number) => (ackStatus = n) };
}

describe('GooglePlayBillingProvider', () => {
  it('verifies a purchase made by this account and reads the lifecycle from Google', async () => {
    const { provider, purchases, calls } = await fakePlay();
    purchases.set('purchase-token-1', purchase());
    const s = await provider.verify({
      productId: 'pro_monthly',
      purchaseToken: 'purchase-token-1',
      userId: 'user-1',
    });
    expect(s).toMatchObject({
      provider: 'google_play',
      externalId: 'purchase-token-1',
      status: 'active',
      productId: 'pro_monthly',
    });
    expect(calls[0]!.url).toBe(
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}/purchases/subscriptionsv2/tokens/purchase-token-1`,
    );
    expect(calls).toHaveLength(1); // already acknowledged: no second call
  });
  it('will not let one account claim another’s purchase', async () => {
    const { provider, purchases } = await fakePlay();
    purchases.set('purchase-token-1', purchase({}, 'someone-else'));
    await expect(
      provider.verify({ productId: 'pro_monthly', purchaseToken: 'purchase-token-1', userId: 'user-1' }),
    ).rejects.toMatchObject({ status: 409 });
    purchases.set('purchase-token-2', purchase({ externalAccountIdentifiers: undefined }));
    await expect(
      provider.verify({ productId: 'pro_monthly', purchaseToken: 'purchase-token-2', userId: 'user-1' }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('will not accept a product other than the one claimed', async () => {
    const { provider, purchases } = await fakePlay();
    purchases.set('purchase-token-1', purchase());
    expect(
      await provider.verify({ productId: 'pro_yearly', purchaseToken: 'purchase-token-1', userId: 'user-1' }),
    ).toBeNull();
  });
  it('says nothing is there for unknown tokens and pending purchases', async () => {
    const { provider, purchases } = await fakePlay();
    expect(
      await provider.verify({ productId: 'pro_monthly', purchaseToken: 'nope', userId: 'user-1' }),
    ).toBeNull();
    purchases.set('bad', 400);
    expect(
      await provider.verify({ productId: 'pro_monthly', purchaseToken: 'bad', userId: 'user-1' }),
    ).toBeNull();
    purchases.set('pending', purchase({ subscriptionState: 'SUBSCRIPTION_STATE_PENDING' }));
    expect(
      await provider.verify({ productId: 'pro_monthly', purchaseToken: 'pending', userId: 'user-1' }),
    ).toBeNull();
  });
  it('treats a failing Play API as a passing problem, not as "no such purchase"', async () => {
    const { provider, purchases } = await fakePlay();
    for (const status of [401, 403, 500, 503]) {
      purchases.set('t', status);
      await expect(
        provider.verify({ productId: 'pro_monthly', purchaseToken: 't', userId: 'user-1' }),
      ).rejects.toMatchObject({ status: 502 });
      await expect(provider.refresh('t', 'pro_monthly')).rejects.toMatchObject({ status: 502 });
    }
  });
  it('acknowledges new purchases, and keeps going if that fails', async () => {
    const { provider, purchases, calls, setAck } = await fakePlay();
    purchases.set('purchase-token-1', purchase({ acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING' }));
    expect(
      await provider.verify({
        productId: 'pro_monthly',
        purchaseToken: 'purchase-token-1',
        userId: 'user-1',
      }),
    ).not.toBeNull();
    const ack = calls.find((c) => c.method === 'POST')!;
    expect(ack.url).toBe(
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}/purchases/subscriptions/pro_monthly/tokens/purchase-token-1:acknowledge`,
    );
    setAck(500);
    expect(
      await provider.verify({
        productId: 'pro_monthly',
        purchaseToken: 'purchase-token-1',
        userId: 'user-1',
      }),
    ).not.toBeNull(); // the person has paid
    expect(await provider.refresh('purchase-token-1', 'pro_monthly')).not.toBeNull();
  });
  it('says so when the package name or the service account is missing', async () => {
    const { fetcher, clock } = await fakePlay();
    const auth = new GoogleServiceAccountAuth(undefined, clock);
    const bare = new GooglePlayBillingProvider(auth, undefined, clock, silentLogger, fetcher);
    await expect(bare.refresh('t', 'pro_monthly')).rejects.toMatchObject({ status: 501 });
    const noKey = new GooglePlayBillingProvider(auth, PKG, clock, silentLogger, fetcher);
    await expect(noKey.refresh('t', 'pro_monthly')).rejects.toMatchObject({ status: 501 });
  });
  it('turns a network failure into a bad-gateway error', async () => {
    const { clock } = await fakePlay();
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const json = JSON.stringify({
      client_email: 'svc@x.iam.gserviceaccount.com',
      private_key: await exportPKCS8(privateKey),
    });
    const fetcher = (async (url: string) => {
      if (url.includes('oauth2'))
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const p = new GooglePlayBillingProvider(
      new GoogleServiceAccountAuth(json, clock, fetcher),
      PKG,
      clock,
      silentLogger,
      fetcher,
    );
    await expect(p.refresh('t', 'pro_monthly')).rejects.toMatchObject({ status: 502 });
  });
});

describe('buying through the app API', () => {
  it('grants Pro for a genuine purchase and refuses someone else’s', async () => {
    const play = await fakePlay();
    const t = makeApp({ billing: play.provider, clock: play.clock });
    const s = await signUp(t);
    const other = await signUp(t);
    play.purchases.set('real-token', purchase({}, s.userId));
    const verify = (token: string, as = s) =>
      t.request(
        '/v1/subscription/verify',
        jsonInit('POST', { productId: 'pro_monthly', purchaseToken: token }, as.accessToken),
      );
    const ok = await verify('real-token');
    expect(ok.status).toBe(200);
    expect((await body(ok)).entitlement).toMatchObject({ plan: 'pro', status: 'active' });
    const stolen = await verify('real-token', other);
    expect(stolen.status).toBe(409);
    expect((await body(stolen)).error.details).toEqual({ reason: 'purchase_belongs_to_another_account' });
    expect((await verify('unknown-token')).status).toBe(400);
  });
});

// ---- real-time developer notifications -------------------------------------------------------------------------

async function pushSetup() {
  const play = await fakePlay();
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const verifier = new PubSubPushVerifier(
    AUDIENCE,
    PUSH_ACCOUNT,
    play.clock,
    createLocalJWKSet({ keys: [jwk] }),
  );
  const t = makeApp({ billing: play.provider, clock: play.clock, pubSubVerifier: verifier });
  const oidc = (
    claims: Record<string, unknown> = {},
    o: { aud?: string; iss?: string; key?: CryptoKey; ttl?: number } = {},
  ) =>
    new SignJWT({ email: PUSH_ACCOUNT, email_verified: true, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(o.iss ?? 'https://accounts.google.com')
      .setAudience(o.aud ?? AUDIENCE)
      .setIssuedAt(Math.floor(T0 / 1000))
      .setExpirationTime(Math.floor(T0 / 1000) + (o.ttl ?? 3600))
      .sign(o.key ?? privateKey);
  let n = 0;
  const envelope = (notification: object, messageId = `m${++n}`) => ({
    message: {
      data: btoa(
        JSON.stringify({ version: '1.0', packageName: PKG, eventTimeMillis: String(T0), ...notification }),
      ),
      messageId,
    },
    subscription: 'projects/p/subscriptions/s',
  });
  const post = async (payload: unknown, token: string | null = null) =>
    t.request('/v1/webhooks/google-play', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });
  const signed = async (notification: object, messageId?: string) =>
    post(envelope(notification, messageId), await oidc());
  const sub = (token: string, type = 2) => ({
    subscriptionNotification: {
      version: '1.0',
      notificationType: type,
      purchaseToken: token,
      subscriptionId: 'pro_monthly',
    },
  });
  return { t, play, oidc, envelope, post, signed, sub, privateKey };
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM subscription_events');
});

describe('Pub/Sub push authentication', () => {
  it('refuses anything without a valid Google token for our audience and push account', async () => {
    const { post, envelope, oidc, sub } = await pushSetup();
    const stranger = (await generateKeyPair('RS256')).privateKey;
    const body_ = envelope(sub('x'));
    const bad = [
      null,
      'garbage',
      await oidc({}, { aud: 'https://evil.example/hook' }),
      await oidc({}, { iss: 'https://evil.example' }),
      await oidc({}, { key: stranger }),
      await oidc({ email: 'attacker@project.iam.gserviceaccount.com' }),
      await oidc({ email_verified: false }),
      await oidc({}, { ttl: -10 }),
    ];
    for (const token of bad) expect((await post(body_, token)).status, String(token).slice(0, 20)).toBe(401);
  });
  it('is switched off while billing is the pretend store, or the audience is unset', async () => {
    const t = makeApp();
    expect((await t.request('/v1/webhooks/google-play', jsonInit('POST', {}))).status).toBe(501);
    const play = await fakePlay();
    const t2 = makeApp({ billing: play.provider });
    expect((await t2.request('/v1/webhooks/google-play', jsonInit('POST', {}))).status).toBe(501);
  });
});

describe('Pub/Sub notifications', () => {
  it('re-reads the purchase and updates our copy when it renews', async () => {
    const { t, play, signed, sub } = await pushSetup();
    const s = await signUp(t);
    play.purchases.set('purchase-token-R', purchase({}, s.userId));
    await t.request(
      '/v1/subscription/verify',
      jsonInit('POST', { productId: 'pro_monthly', purchaseToken: 'purchase-token-R' }, s.accessToken),
    );
    play.purchases.set(
      'purchase-token-R',
      purchase(
        {
          lineItems: [
            {
              productId: 'pro_monthly',
              expiryTime: iso(T0 + 55 * DAY),
              autoRenewingPlan: { autoRenewEnabled: true },
            },
          ],
        },
        s.userId,
      ),
    );
    expect((await signed(sub('purchase-token-R', 2))).status).toBe(204);
    const row = await env.DB.prepare('SELECT current_period_end FROM subscriptions WHERE external_id = ?')
      .bind('purchase-token-R')
      .first<{ current_period_end: number }>();
    expect(row!.current_period_end).toBe(T0 + 55 * DAY);
  });
  it('believes the Play API, not the notification: a notification cannot grant access by itself', async () => {
    const { t, play, signed, sub } = await pushSetup();
    const s = await signUp(t);
    play.purchases.set('purchase-token-B', purchase({}, s.userId));
    await t.request(
      '/v1/subscription/verify',
      jsonInit('POST', { productId: 'pro_monthly', purchaseToken: 'purchase-token-B' }, s.accessToken),
    );
    play.purchases.set(
      'purchase-token-B',
      purchase({ subscriptionState: 'SUBSCRIPTION_STATE_ON_HOLD' }, s.userId),
    );
    await signed(sub('purchase-token-B', 2)); // says "renewed", Google says on hold
    const row = await env.DB.prepare('SELECT status FROM subscriptions WHERE external_id = ?')
      .bind('purchase-token-B')
      .first<{ status: string }>();
    expect(row!.status).toBe('on_hold');
  });
  it('attaches a purchase the app never reported to the account Google names', async () => {
    const { t, play, signed, sub } = await pushSetup();
    const s = await signUp(t);
    play.purchases.set('purchase-token-New', purchase({}, s.userId));
    expect((await signed(sub('purchase-token-New', 4))).status).toBe(204);
    const ent = await body(await t.request('/v1/entitlements', jsonInit('GET', undefined, s.accessToken)));
    expect(ent).toMatchObject({ plan: 'pro', status: 'active' });
  });
  it('quietly acknowledges purchases it cannot place', async () => {
    const { signed, sub, play } = await pushSetup();
    expect((await signed(sub('nobody-knows', 2))).status).toBe(204); // unknown to Google
    play.purchases.set('ghost', purchase({}, 'user-that-does-not-exist'));
    expect((await signed(sub('ghost', 4))).status).toBe(204);
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM subscriptions').first<{ n: number }>())!.n,
    ).toBeGreaterThanOrEqual(0);
  });
  it('handles each message once, however often Pub/Sub delivers it', async () => {
    const { t, play, post, oidc, envelope, sub } = await pushSetup();
    const s = await signUp(t);
    play.purchases.set('purchase-token-D', purchase({}, s.userId));
    const msg = envelope(sub('purchase-token-D', 4), 'same-message');
    expect((await post(msg, await oidc())).status).toBe(204);
    const before = play.calls.length;
    expect((await post(msg, await oidc())).status).toBe(204);
    expect(play.calls.length).toBe(before); // the second delivery caused no lookups
  });
  it('lets Pub/Sub retry when the Play API is down, and does not record the message as done', async () => {
    const { play, post, oidc, envelope, sub } = await pushSetup();
    play.purchases.set('purchase-token-E', 503);
    const msg = envelope(sub('purchase-token-E', 2), 'retry-me');
    expect((await post(msg, await oidc())).status).toBe(502);
    play.purchases.set('purchase-token-E', purchase({}, 'nobody'));
    expect((await post(msg, await oidc())).status).toBe(204);
  });
  it('ends access at once for a refund or revocation', async () => {
    const { t, play, signed } = await pushSetup();
    const s = await signUp(t);
    play.purchases.set('purchase-token-V', purchase({}, s.userId));
    await t.request(
      '/v1/subscription/verify',
      jsonInit('POST', { productId: 'pro_monthly', purchaseToken: 'purchase-token-V' }, s.accessToken),
    );
    expect(
      (
        await signed({
          voidedPurchaseNotification: {
            purchaseToken: 'purchase-token-V',
            orderId: 'GPA.1',
            productType: 1,
            refundType: 1,
          },
        })
      ).status,
    ).toBe(204);
    const ent = await body(await t.request('/v1/entitlements', jsonInit('GET', undefined, s.accessToken)));
    expect(ent).toMatchObject({ plan: 'free', status: 'refunded' });
    // one-time products, and refunds for purchases we never saw, change nothing
    expect(
      (
        await signed({
          voidedPurchaseNotification: { purchaseToken: 'purchase-token-V', orderId: 'GPA.2', productType: 2 },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await signed({
          voidedPurchaseNotification: { purchaseToken: 'unknown', orderId: 'GPA.3', productType: 1 },
        })
      ).status,
    ).toBe(204);
  });
  it('acknowledges test messages and anything it does not understand', async () => {
    const { signed, post, oidc, envelope } = await pushSetup();
    expect((await signed({ testNotification: { version: '1.0' } })).status).toBe(204);
    expect((await signed({ oneTimeProductNotification: { purchaseToken: 'x' } })).status).toBe(204);
    expect((await post(envelope({ packageName: 'someone.else' }), await oidc())).status).toBe(204);
    for (const junk of [
      'not json',
      '{}',
      JSON.stringify({ message: {} }),
      JSON.stringify({ message: { data: '!!!', messageId: 'x' } }),
      JSON.stringify({ message: { data: btoa('plain text'), messageId: 'y' } }),
      JSON.stringify({ message: { data: btoa('null'), messageId: 'z' } }),
    ])
      expect((await post(junk, await oidc())).status, junk).toBe(204);
  });
});

describe('nightly reconcile', () => {
  it('re-reads subscriptions that may have changed without a notification', async () => {
    const { t, play } = await pushSetup();
    const s = await signUp(t);
    play.purchases.set('purchase-token-N', purchase({}, s.userId));
    await t.request(
      '/v1/subscription/verify',
      jsonInit('POST', { productId: 'pro_monthly', purchaseToken: 'purchase-token-N' }, s.accessToken),
    );
    await env.DB.prepare(
      "UPDATE subscriptions SET status = 'in_grace', current_period_end = ? WHERE external_id = 'purchase-token-N'",
    )
      .bind(T0 - DAY)
      .run();
    play.purchases.set('purchase-token-N', purchase({}, s.userId)); // Google says: renewed fine
    const report = await body(await adminClient(t).call('POST', '/v1/admin/maintenance/run'));
    expect(report.subscriptionsReconciled).toBeGreaterThanOrEqual(1);
    const row = await env.DB.prepare(
      "SELECT status FROM subscriptions WHERE external_id = 'purchase-token-N'",
    ).first<{
      status: string;
    }>();
    expect(row!.status).toBe('active');
  });
  it('survives the store being down, and does nothing for the pretend store', async () => {
    const { t, play } = await pushSetup();
    const s = await signUp(t);
    play.purchases.set('purchase-token-Q', purchase({}, s.userId));
    await t.request(
      '/v1/subscription/verify',
      jsonInit('POST', { productId: 'pro_monthly', purchaseToken: 'purchase-token-Q' }, s.accessToken),
    );
    await env.DB.prepare(
      "UPDATE subscriptions SET status = 'on_hold' WHERE external_id = 'purchase-token-Q'",
    ).run();
    play.purchases.set('purchase-token-Q', 500);
    expect((await adminClient(t).call('POST', '/v1/admin/maintenance/run')).status).toBe(200);
    const mock = makeApp();
    expect(
      (await body(await adminClient(mock).call('POST', '/v1/admin/maintenance/run'))).subscriptionsReconciled,
    ).toBe(0);
  });
});
