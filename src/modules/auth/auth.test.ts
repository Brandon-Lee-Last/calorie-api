import { env } from 'cloudflare:workers';
import { SignJWT, generateKeyPair } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryRateLimiter } from '../../core/rate-limiter';
import { DAY, FakeClock, MINUTE } from '../../core/time';
import { GOOGLE_CLIENT, makeGoogle } from '../../../test/helpers/google';
import { T0, body, jsonInit, makeApp, signUp, type SessionBody } from '../../../test/helpers/app';
import { REFRESH_REUSE_GRACE_MS } from './auth.service';

const refresh = (t: ReturnType<typeof makeApp>, refreshToken: string) =>
  t.request('/v1/auth/refresh', jsonInit('POST', { refreshToken }));

describe('anonymous accounts', () => {
  it('creates an account and a profile, and the access token works', async () => {
    const t = makeApp();
    const res = await t.request('/v1/auth/anonymous', jsonInit('POST', { deviceLabel: 'Pixel 8' }));
    expect(res.status).toBe(201);
    const s = await body<SessionBody>(res);
    expect(s).toMatchObject({ tokenType: 'Bearer', expiresIn: 900, isAnonymous: true });
    expect(s.userId).toHaveLength(26);
    expect(s.refreshToken.length).toBeGreaterThanOrEqual(43);
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(s.userId).first();
    const profile = await env.DB.prepare('SELECT * FROM user_profiles WHERE user_id = ?')
      .bind(s.userId)
      .first();
    expect(user).toBeTruthy();
    expect(profile).toMatchObject({ calorie_goal: 2000, units: 'metric', goal: 'maintain' });
    const out = await t.request('/v1/auth/logout-all', jsonInit('POST', undefined, s.accessToken));
    expect(out.status).toBe(204);
  });
  it('works with no body at all', async () => {
    const t = makeApp();
    const res = await t.request('/v1/auth/anonymous', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(201);
  });
  it('stores only a hash of the refresh token', async () => {
    const t = makeApp();
    const s = await signUp(t);
    const rows = await env.DB.prepare('SELECT token_hash FROM refresh_tokens WHERE user_id = ?')
      .bind(s.userId)
      .all<{ token_hash: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.token_hash).not.toBe(s.refreshToken);
    expect(rows.results[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects bad input with a validation error', async () => {
    const t = makeApp();
    const res = await t.request('/v1/auth/anonymous', jsonInit('POST', { deviceLabel: '' }));
    expect(res.status).toBe(422);
    const b = await body(res);
    expect(b.error.code).toBe('validation_failed');
    expect(b.error.details[0].path).toBe('deviceLabel');
  });
  it('limits how fast one address can create accounts', async () => {
    const clock = new FakeClock(T0);
    const t = makeApp({ clock, rateLimiter: new MemoryRateLimiter(clock) });
    const init = jsonInit('POST', {}, undefined, { 'cf-connecting-ip': '203.0.113.9' });
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await t.request('/v1/auth/anonymous', init)).status;
    expect(last).toBe(429);
  });
});

describe('access tokens', () => {
  it('are required, and must be well formed', async () => {
    const t = makeApp();
    expect((await t.request('/v1/auth/logout-all', jsonInit('POST'))).status).toBe(401);
    expect((await t.request('/v1/auth/logout-all', jsonInit('POST', undefined, 'not-a-jwt'))).status).toBe(
      401,
    );
    expect(
      (await t.request('/v1/auth/logout-all', { method: 'POST', headers: { authorization: 'Basic abc' } }))
        .status,
    ).toBe(401);
  });
  it('expire after 15 minutes with a distinct error code', async () => {
    const t = makeApp();
    const s = await signUp(t);
    t.clock.advance(14 * MINUTE);
    expect((await t.request('/v1/auth/logout-all', jsonInit('POST', undefined, s.accessToken))).status).toBe(
      204,
    );
    t.clock.advance(2 * MINUTE);
    const res = await t.request('/v1/auth/logout-all', jsonInit('POST', undefined, s.accessToken));
    expect(res.status).toBe(401);
    expect((await body(res)).error.code).toBe('token_expired');
  });
  it('are rejected when signed with another secret or algorithm', async () => {
    const t = makeApp();
    const s = await signUp(t);
    const payload = JSON.parse(atob(s.accessToken.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    const forged = await new SignJWT({ sid: payload.sid })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(s.userId)
      .setIssuer('calorie-api')
      .setAudience('calorie-app')
      .setExpirationTime(Math.floor(T0 / 1000) + 600)
      .sign(new TextEncoder().encode('a-different-secret-that-is-long-enough-xx'));
    expect((await t.request('/v1/auth/logout-all', jsonInit('POST', undefined, forged))).status).toBe(401);
    const none = `${btoa('{"alg":"none"}').replace(/=/g, '')}.${s.accessToken.split('.')[1]}.`;
    expect((await t.request('/v1/auth/logout-all', jsonInit('POST', undefined, none))).status).toBe(401);
    const wrongAudience = await new SignJWT({ sid: payload.sid })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(s.userId)
      .setIssuer('calorie-api')
      .setAudience('someone-else')
      .setExpirationTime(Math.floor(T0 / 1000) + 600)
      .sign(new TextEncoder().encode(env.JWT_SECRET));
    expect((await t.request('/v1/auth/logout-all', jsonInit('POST', undefined, wrongAudience))).status).toBe(
      401,
    );
  });
});

describe('refresh tokens', () => {
  it('rotate: a new pair is issued and the account is the same', async () => {
    const t = makeApp();
    const s = await signUp(t);
    t.clock.advance(20 * MINUTE);
    const res = await refresh(t, s.refreshToken);
    expect(res.status).toBe(200);
    const n = await body<SessionBody>(res);
    expect(n.userId).toBe(s.userId);
    expect(n.refreshToken).not.toBe(s.refreshToken);
    expect(n.accessToken).not.toBe(s.accessToken);
    expect((await t.request('/v1/auth/logout-all', jsonInit('POST', undefined, n.accessToken))).status).toBe(
      204,
    );
  });
  it('can be chained many times', async () => {
    const t = makeApp();
    let s = await signUp(t);
    for (let i = 0; i < 5; i++) {
      t.clock.advance(MINUTE);
      s = await body<SessionBody>(await refresh(t, s.refreshToken));
    }
    expect(s.userId).toHaveLength(26);
  });
  it('allow a quick retry of the same token (lost response) without signing the device out', async () => {
    const t = makeApp();
    const s = await signUp(t);
    expect((await refresh(t, s.refreshToken)).status).toBe(200);
    t.clock.advance(REFRESH_REUSE_GRACE_MS - 1000);
    expect((await refresh(t, s.refreshToken)).status).toBe(200);
  });
  it('reusing a spent token after the grace window ends the whole session', async () => {
    const t = makeApp();
    const s = await signUp(t);
    const next = await body<SessionBody>(await refresh(t, s.refreshToken));
    t.clock.advance(REFRESH_REUSE_GRACE_MS + 1000);
    const replay = await refresh(t, s.refreshToken);
    expect(replay.status).toBe(401);
    expect((await body(replay)).error.message).toMatch(/already used/);
    expect((await refresh(t, next.refreshToken)).status).toBe(401); // the legitimate holder is signed out too
  });
  it('expire after 90 days', async () => {
    const t = makeApp();
    const s = await signUp(t);
    t.clock.advance(91 * DAY);
    expect((await refresh(t, s.refreshToken)).status).toBe(401);
  });
  it('slide: each refresh pushes expiry out', async () => {
    const t = makeApp();
    let s = await signUp(t);
    t.clock.advance(60 * DAY);
    s = await body<SessionBody>(await refresh(t, s.refreshToken));
    t.clock.advance(60 * DAY);
    expect((await refresh(t, s.refreshToken)).status).toBe(200);
  });
  it('are not accepted when unknown or malformed', async () => {
    const t = makeApp();
    expect((await refresh(t, 'x'.repeat(43))).status).toBe(401);
    expect((await refresh(t, 'short')).status).toBe(422);
  });
  it('stop working for a deleted account', async () => {
    const t = makeApp();
    const s = await signUp(t);
    await env.DB.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').bind(T0, s.userId).run();
    expect((await refresh(t, s.refreshToken)).status).toBe(401);
  });
});

describe('logout', () => {
  it('revokes the session and is safe to repeat', async () => {
    const t = makeApp();
    const s = await signUp(t);
    expect(
      (await t.request('/v1/auth/logout', jsonInit('POST', { refreshToken: s.refreshToken }))).status,
    ).toBe(204);
    expect((await refresh(t, s.refreshToken)).status).toBe(401);
    expect(
      (await t.request('/v1/auth/logout', jsonInit('POST', { refreshToken: s.refreshToken }))).status,
    ).toBe(204);
    expect(
      (await t.request('/v1/auth/logout', jsonInit('POST', { refreshToken: 'y'.repeat(43) }))).status,
    ).toBe(204);
  });
  it('logout-all ends every device', async () => {
    const t = makeApp();
    const a = await signUp(t);
    // a second sign-in for the same user: log in on another "device" via google link is covered below; here use refresh families
    const second = await body<SessionBody>(await refresh(t, a.refreshToken));
    expect(
      (await t.request('/v1/auth/logout-all', jsonInit('POST', undefined, second.accessToken))).status,
    ).toBe(204);
    expect((await refresh(t, second.refreshToken)).status).toBe(401);
    expect((await refresh(t, a.refreshToken)).status).toBe(401);
  });
});

describe('google sign-in', () => {
  let g: Awaited<ReturnType<typeof makeGoogle>>;
  let t: ReturnType<typeof makeApp>;
  const google = (idToken: string, extra: Record<string, unknown> = {}, token?: string) =>
    t.request('/v1/auth/google', jsonInit('POST', { idToken, ...extra }, token));

  beforeEach(async () => {
    const clock = new FakeClock(T0);
    g = await makeGoogle(clock);
    t = makeApp({ clock, googleVerifier: g.verifier });
    await env.DB.exec('DELETE FROM identities');
  });

  it('creates an account on first sign-in and signs into it the next time', async () => {
    const first = await google(
      await g.issue({ sub: 'g-1', email: 'a@example.com', email_verified: true, name: 'Ayanda' }),
    );
    expect(first.status).toBe(200);
    const a = await body(first);
    expect(a).toMatchObject({ created: true, linked: false, isAnonymous: false });
    const user = await env.DB.prepare('SELECT email, display_name FROM users WHERE id = ?')
      .bind(a.userId)
      .first();
    expect(user).toEqual({ email: 'a@example.com', display_name: 'Ayanda' });
    const again = await body(await google(await g.issue({ sub: 'g-1' })));
    expect(again).toMatchObject({ created: false, userId: a.userId });
  });
  it('ignores an unverified email', async () => {
    const r = await body(
      await google(await g.issue({ sub: 'g-2', email: 'x@example.com', email_verified: false })),
    );
    const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(r.userId).first();
    expect(user).toEqual({ email: null });
  });
  it('links Google to the signed-in anonymous account and keeps its data', async () => {
    const anon = await signUp(t);
    const res = await google(
      await g.issue({ sub: 'g-3', email: 'l@example.com', email_verified: true }),
      {},
      anon.accessToken,
    );
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({
      linked: true,
      created: false,
      userId: anon.userId,
      isAnonymous: false,
    });
  });
  it('refuses to link a second Google account to one that already has Google', async () => {
    const anon = await signUp(t);
    await google(await g.issue({ sub: 'g-4' }), {}, anon.accessToken);
    const res = await google(await g.issue({ sub: 'g-5' }), {}, anon.accessToken);
    expect(res.status).toBe(409);
    expect((await body(res)).error.details.reason).toBe('already_linked');
  });
  it('warns before leaving anonymous data behind, then proceeds when told to', async () => {
    const owner = await body(await google(await g.issue({ sub: 'g-6' })));
    const anon = await signUp(t);
    const blocked = await google(await g.issue({ sub: 'g-6' }), {}, anon.accessToken);
    expect(blocked.status).toBe(409);
    expect((await body(blocked)).error.details.reason).toBe('identity_in_use');
    const ok = await google(await g.issue({ sub: 'g-6' }), { discardAnonymousData: true }, anon.accessToken);
    expect(ok.status).toBe(200);
    expect((await body(ok)).userId).toBe(owner.userId);
  });
  it('lets a person who is signed in with another Google account switch', async () => {
    const a = await body(await google(await g.issue({ sub: 'g-7' })));
    const b = await body(await google(await g.issue({ sub: 'g-8' })));
    const switched = await google(await g.issue({ sub: 'g-7' }), {}, b.accessToken);
    expect(switched.status).toBe(200);
    expect((await body(switched)).userId).toBe(a.userId);
  });
  it('frees the identity of a deleted account so the person can start over', async () => {
    const old = await body(await google(await g.issue({ sub: 'g-9' })));
    await env.DB.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').bind(T0, old.userId).run();
    const fresh = await body(await google(await g.issue({ sub: 'g-9' })));
    expect(fresh.created).toBe(true);
    expect(fresh.userId).not.toBe(old.userId);
  });
  it('rejects forged, mis-addressed, expired and malformed tokens', async () => {
    const { privateKey: other } = await generateKeyPair('RS256');
    expect((await google(await g.issue({ sub: 'x' }, { key: other }))).status).toBe(401);
    expect((await google(await g.issue({ sub: 'x' }, { audience: 'someone-else' }))).status).toBe(401);
    expect((await google(await g.issue({ sub: 'x' }, { issuer: 'https://evil.example.com' }))).status).toBe(
      401,
    );
    expect(
      (
        await google(
          await g.issue({ sub: 'x' }, { expiresInSeconds: 60 }).then(async (tok) => {
            t.clock.advance(5 * MINUTE);
            return tok;
          }),
        )
      ).status,
    ).toBe(401);
    expect((await google('a'.repeat(30))).status).toBe(401);
    expect((await google('short')).status).toBe(422);
  });
  it('says so when Google sign-in is not configured', async () => {
    const plain = makeApp();
    const res = await plain.request('/v1/auth/google', jsonInit('POST', { idToken: 'a'.repeat(40) }));
    expect(res.status).toBe(501);
    expect((await body(res)).error.code).toBe('not_configured');
  });
  it('rejects an expired access token on the link call instead of treating it as anonymous', async () => {
    const anon = await signUp(t);
    t.clock.advance(20 * MINUTE);
    const res = await google(await g.issue({ sub: 'g-10' }), {}, anon.accessToken);
    expect(res.status).toBe(401);
    expect((await body(res)).error.code).toBe('token_expired');
  });
  it('uses the configured audience', () => {
    expect(GOOGLE_CLIENT).toContain('apps.googleusercontent.com');
  });
});
