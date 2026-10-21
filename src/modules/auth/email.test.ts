import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryMailer } from '../../../test/helpers/mailer';
import { makeGoogle } from '../../../test/helpers/google';
import { T0, body, jsonInit, makeApp, signUp, type TestApp } from '../../../test/helpers/app';
import { D1RateLimiter } from '../../core/rate-limiter';
import { DAY, FakeClock } from '../../core/time';
import { silentLogger } from '../../core/logger';
import {
  CODE_TTL_MS,
  MAX_CODES_PER_DAY,
  MAX_CODE_ATTEMPTS,
  RESEND_COOLDOWN_MS,
  generateCode,
  normaliseEmail,
} from './email.service';
import { LogMailer, ResendMailer, unconfiguredMailer } from './mailer';

const ADDRESS = 'Person@Example.com';
const CANON = 'person@example.com';

let mailer: MemoryMailer;
let t: TestApp;
let clock: FakeClock;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM email_codes');
  await env.DB.exec('DELETE FROM identities');
  mailer = new MemoryMailer();
  clock = new FakeClock(T0);
  t = makeApp({ clock, mailer });
});

const start = (email = ADDRESS, extra: Record<string, string> = {}) =>
  t.request('/v1/auth/email/start', jsonInit('POST', { email }, undefined, extra));
const verify = (data: Record<string, unknown>, token?: string) =>
  t.request('/v1/auth/email/verify', jsonInit('POST', data, token));

describe('requesting a code', () => {
  it('emails a six digit code and always answers the same way', async () => {
    const res = await start();
    expect(res.status).toBe(202);
    expect(await body(res)).toEqual({ sent: true, expiresIn: CODE_TTL_MS / 1000, resendAfter: 60 });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe(CANON);
    expect(mailer.codeFor(CANON)).toMatch(/^\d{6}$/);
  });
  it('rejects malformed addresses', async () => {
    for (const email of ['', 'nope', 'a@', '@b.co', 'a b@c.co', 'x'.repeat(260) + '@a.co', 5])
      expect((await start(email as string)).status).toBe(422);
    expect(mailer.sent).toHaveLength(0);
  });
  it('stores neither the address nor the code', async () => {
    await start();
    const code = mailer.codeFor(CANON);
    const rows = (await env.DB.prepare('SELECT * FROM email_codes').all()).results;
    expect(rows).toHaveLength(1);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(CANON);
    expect(dump).not.toContain(code);
  });
  it('sends nothing, and says nothing, when asked again within a minute', async () => {
    await start();
    const again = await start();
    expect(again.status).toBe(202);
    expect(mailer.sent).toHaveLength(1);
    clock.advance(RESEND_COOLDOWN_MS + 1);
    await start();
    expect(mailer.sent).toHaveLength(2);
  });
  it('replaces the older code: only the newest works', async () => {
    await start();
    const first = mailer.codeFor(CANON);
    clock.advance(RESEND_COOLDOWN_MS + 1);
    await start();
    const second = mailer.codeFor(CANON);
    expect((await verify({ email: CANON, code: first })).status).toBe(second === first ? 200 : 400);
    if (second !== first) expect((await verify({ email: CANON, code: second })).status).toBe(200);
  });
  it('caps how many codes one address gets in a day', async () => {
    for (let i = 0; i < MAX_CODES_PER_DAY + 3; i++) {
      expect((await start()).status).toBe(202);
      clock.advance(RESEND_COOLDOWN_MS + 1);
    }
    expect(mailer.sent).toHaveLength(MAX_CODES_PER_DAY);
    clock.advance(DAY);
    await start();
    expect(mailer.sent).toHaveLength(MAX_CODES_PER_DAY + 1);
  });
  it('does not count a code that could not be sent, and reports the failure', async () => {
    mailer.fail = true;
    expect((await start()).status).toBeGreaterThanOrEqual(500);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM email_codes').first<{ n: number }>())!.n).toBe(0);
    mailer.fail = false;
    expect((await start()).status).toBe(202);
    expect(mailer.sent).toHaveLength(1);
  });
  it('limits requests from one address with the shared limiter', async () => {
    await env.DB.exec('DELETE FROM rate_limits');
    const limited = makeApp({ clock, mailer, strictLimiter: new D1RateLimiter(env.DB, clock) });
    const ip = { 'cf-connecting-ip': '203.0.113.77' };
    let last = 0;
    for (let i = 0; i < 11; i++)
      last = (
        await limited.request(
          '/v1/auth/email/start',
          jsonInit('POST', { email: `u${i}@example.com` }, undefined, ip),
        )
      ).status;
    expect(last).toBe(429);
  });
});

describe('signing in with a code', () => {
  it('creates an account the first time and signs in to it the next time', async () => {
    await start();
    const res = await verify({ email: ADDRESS, code: mailer.codeFor(CANON), deviceLabel: 'Pixel' });
    expect(res.status).toBe(200);
    const first = await body(res);
    expect(first).toMatchObject({ created: true, linked: false, isAnonymous: false });
    const me = await body(await t.request('/v1/me', jsonInit('GET', undefined, first.accessToken)));
    expect(me).toMatchObject({ email: CANON, isAnonymous: false, providers: ['email'] });

    clock.advance(RESEND_COOLDOWN_MS + 1);
    await start();
    const second = await body(await verify({ email: CANON, code: mailer.codeFor(CANON) }));
    expect(second).toMatchObject({ created: false, userId: first.userId });
  });
  it('works only once', async () => {
    await start();
    const code = mailer.codeFor(CANON);
    expect((await verify({ email: CANON, code })).status).toBe(200);
    const replay = await verify({ email: CANON, code });
    expect(replay.status).toBe(400);
    expect((await body(replay)).error.code).toBe('invalid_code');
  });
  it('fails the same way for a wrong code, an unknown address and an expired code', async () => {
    await start();
    const code = mailer.codeFor(CANON);
    const wrong = code === '000000' ? '111111' : '000000';
    const results = [
      await verify({ email: CANON, code: wrong }),
      await verify({ email: 'stranger@example.com', code }),
    ];
    clock.advance(CODE_TTL_MS + 1);
    results.push(await verify({ email: CANON, code }));
    for (const r of results) {
      expect(r.status).toBe(400);
      expect((await body(r)).error).toMatchObject({ code: 'invalid_code' });
    }
  });
  it('burns the code after too many wrong guesses, even if the right one follows', async () => {
    await start();
    const code = mailer.codeFor(CANON);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++)
      expect((await verify({ email: CANON, code: wrong })).status).toBe(400);
    expect((await verify({ email: CANON, code })).status).toBe(400);
    clock.advance(RESEND_COOLDOWN_MS + 1);
    await start();
    expect((await verify({ email: CANON, code: mailer.codeFor(CANON) })).status).toBe(200);
  });
  it('lets only one of two simultaneous attempts with the right code in', async () => {
    await start();
    const code = mailer.codeFor(CANON);
    const results = await Promise.all([1, 2, 3, 4].map(() => verify({ email: CANON, code })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });
  it('rejects codes that are not six digits before touching the database', async () => {
    for (const code of ['12345', '1234567', 'abcdef', '12 456', '']) {
      const res = await verify({ email: CANON, code });
      expect(res.status).toBe(422);
    }
  });
  it('limits guessing from one address with the shared limiter', async () => {
    await env.DB.exec('DELETE FROM rate_limits');
    const limited = makeApp({ clock, mailer, strictLimiter: new D1RateLimiter(env.DB, clock) });
    const ip = { 'cf-connecting-ip': '203.0.113.78' };
    let last = 0;
    for (let i = 0; i < 31; i++)
      last = (
        await limited.request(
          '/v1/auth/email/verify',
          jsonInit('POST', { email: `v${i}@example.com`, code: '123456' }, undefined, ip),
        )
      ).status;
    expect(last).toBe(429);
  });
});

describe('linking email to an anonymous account', () => {
  it('keeps the data and makes the account recoverable', async () => {
    const anon = await signUp(t);
    await t.request('/v1/body/weights', jsonInit('GET', undefined, anon.accessToken));
    await start();
    const res = await verify({ email: CANON, code: mailer.codeFor(CANON) }, anon.accessToken);
    expect(await body(res)).toMatchObject({
      linked: true,
      created: false,
      userId: anon.userId,
      isAnonymous: false,
    });
    // now a brand new device can get back into the same account
    clock.advance(RESEND_COOLDOWN_MS + 1);
    await start();
    const other = await body(await verify({ email: CANON, code: mailer.codeFor(CANON) }));
    expect(other.userId).toBe(anon.userId);
  });
  it('warns before leaving anonymous data behind for an email that already has an account', async () => {
    await start();
    const owner = await body(await verify({ email: CANON, code: mailer.codeFor(CANON) }));
    const anon = await signUp(t);
    clock.advance(RESEND_COOLDOWN_MS + 1);
    await start();
    const code = mailer.codeFor(CANON);
    const blocked = await verify({ email: CANON, code }, anon.accessToken);
    expect(blocked.status).toBe(409);
    expect((await body(blocked)).error.details).toEqual({ reason: 'identity_in_use' });
    clock.advance(RESEND_COOLDOWN_MS + 1);
    await start();
    const ok = await verify(
      { email: CANON, code: mailer.codeFor(CANON), discardAnonymousData: true },
      anon.accessToken,
    );
    expect((await body(ok)).userId).toBe(owner.userId);
  });
  it('refuses a second email on the same account', async () => {
    const anon = await signUp(t);
    await start();
    await verify({ email: CANON, code: mailer.codeFor(CANON) }, anon.accessToken);
    await start('second@example.com');
    const res = await verify(
      { email: 'second@example.com', code: mailer.codeFor('second@example.com') },
      anon.accessToken,
    );
    expect(res.status).toBe(409);
    expect((await body(res)).error.details).toEqual({ reason: 'already_linked' });
  });
});

describe('the same mailbox across Google and email', () => {
  it('is one person: emailing a code to a Google account’s address signs in to that account', async () => {
    const g = await makeGoogle(clock);
    const tt = makeApp({ clock, mailer, googleVerifier: g.verifier });
    const viaGoogle = await body(
      await tt.request(
        '/v1/auth/google',
        jsonInit('POST', { idToken: await g.issue({ sub: 'g-1', email: CANON, email_verified: true }) }),
      ),
    );
    await tt.request('/v1/auth/email/start', jsonInit('POST', { email: CANON }));
    const viaEmail = await body(
      await tt.request(
        '/v1/auth/email/verify',
        jsonInit('POST', { email: CANON, code: mailer.codeFor(CANON) }),
      ),
    );
    expect(viaEmail).toMatchObject({ userId: viaGoogle.userId, created: false });
    const me = await body(await tt.request('/v1/me', jsonInit('GET', undefined, viaEmail.accessToken)));
    expect(me.providers.sort()).toEqual(['email', 'google']);
  });
  it('does not merge on an unverified Google email', async () => {
    const g = await makeGoogle(clock);
    const tt = makeApp({ clock, mailer, googleVerifier: g.verifier });
    const viaGoogle = await body(
      await tt.request(
        '/v1/auth/google',
        jsonInit('POST', { idToken: await g.issue({ sub: 'g-2', email: CANON, email_verified: false }) }),
      ),
    );
    await tt.request('/v1/auth/email/start', jsonInit('POST', { email: CANON }));
    const viaEmail = await body(
      await tt.request(
        '/v1/auth/email/verify',
        jsonInit('POST', { email: CANON, code: mailer.codeFor(CANON) }),
      ),
    );
    expect(viaEmail.userId).not.toBe(viaGoogle.userId);
  });
  it('lets a Google account add its email as a second way back in', async () => {
    const g = await makeGoogle(clock);
    const tt = makeApp({ clock, mailer, googleVerifier: g.verifier });
    const viaGoogle = await body(
      await tt.request('/v1/auth/google', jsonInit('POST', { idToken: await g.issue({ sub: 'g-3' }) })),
    );
    await tt.request('/v1/auth/email/start', jsonInit('POST', { email: 'backup@example.com' }));
    const res = await tt.request(
      '/v1/auth/email/verify',
      jsonInit(
        'POST',
        { email: 'backup@example.com', code: mailer.codeFor('backup@example.com') },
        viaGoogle.accessToken,
      ),
    );
    expect(await body(res)).toMatchObject({ linked: true, userId: viaGoogle.userId });
  });
});

describe('sign-in data for a deleted account', () => {
  it('frees the address so the person can start again', async () => {
    await start();
    const first = await body(await verify({ email: CANON, code: mailer.codeFor(CANON) }));
    const del = await t.request(
      '/v1/account',
      jsonInit('DELETE', { confirm: 'DELETE MY ACCOUNT' }, first.accessToken),
    );
    expect(del.status).toBe(200);
    clock.advance(RESEND_COOLDOWN_MS + 1);
    await start();
    const again = await body(await verify({ email: CANON, code: mailer.codeFor(CANON) }));
    expect(again).toMatchObject({ created: true });
    expect(again.userId).not.toBe(first.userId);
  });
});

describe('helpers', () => {
  it('normalises addresses', () => {
    expect(normaliseEmail('  Person@Example.COM ')).toBe(CANON);
  });
  it('generates evenly spread six digit codes, retrying the uneven tail', () => {
    expect(generateCode()).toMatch(/^\d{6}$/);
    expect(generateCode(() => new Uint32Array([7]))).toBe('000007');
    expect(generateCode(() => new Uint32Array([999_999]))).toBe('999999');
    const draws = [0xffff_ffff, 0xffff_fff0, 42];
    expect(generateCode(() => new Uint32Array([draws.shift()!]))).toBe('000042');
  });
});

describe('mailers', () => {
  const mail = { to: CANON, subject: 'Hi', text: 'Code 123456' };
  it('Resend posts the email with the key', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetcher = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await new ResendMailer('re_key', 'Calories <login@example.com>', fetcher).send(mail);
    expect(seen!.url).toBe('https://api.resend.com/emails');
    expect((seen!.init.headers as Record<string, string>).authorization).toBe('Bearer re_key');
    expect(JSON.parse(seen!.init.body as string)).toEqual({
      from: 'Calories <login@example.com>',
      to: [CANON],
      subject: 'Hi',
      text: 'Code 123456',
    });
  });
  it('Resend failures become upstream_failed', async () => {
    const bad = (async () => new Response('no', { status: 422 })) as unknown as typeof fetch;
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(new ResendMailer('k', 'f', bad).send(mail)).rejects.toMatchObject({ status: 502 });
    await expect(new ResendMailer('k', 'f', down).send(mail)).rejects.toMatchObject({ status: 502 });
  });
  it('the log mailer only logs, and production without a mail service refuses', async () => {
    const lines: unknown[] = [];
    await new LogMailer({ ...silentLogger, info: (...a: unknown[]) => void lines.push(a) } as never).send(
      mail,
    );
    expect(lines).toHaveLength(1);
    await expect(unconfiguredMailer.send(mail)).rejects.toMatchObject({ status: 501 });
  });
});

describe('choosing a mailer', () => {
  it('uses Resend when it is configured, and production without one refuses to send', async () => {
    const calls: string[] = [];
    const fetcher = (async (url: string) => {
      calls.push(url);
      return new Response('{}');
    }) as unknown as typeof fetch;
    const app = makeApp({ clock, fetcher }).app;
    const withKey = { ...env, RESEND_API_KEY: 're_key', EMAIL_FROM: 'login@example.com' };
    const res = await app.request('/v1/auth/email/start', jsonInit('POST', { email: CANON }), withKey);
    expect(res.status).toBe(202);
    expect(calls).toEqual(['https://api.resend.com/emails']);

    const production = {
      ...env,
      ENVIRONMENT: 'production',
      SIMULATE_ENABLED: 'false',
      BILLING_PROVIDER: 'mock',
    };
    const refused = await makeApp({ clock }).app.request(
      '/v1/auth/email/start',
      jsonInit('POST', { email: 'other@example.com' }),
      production,
    );
    expect(refused.status).toBe(501);
  });
});
