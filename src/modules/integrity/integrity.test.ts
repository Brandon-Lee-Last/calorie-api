import { exportPKCS8, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { body, jsonInit, makeApp, T0 } from '../../../test/helpers/app';
import { GoogleServiceAccountAuth } from '../../core/google-auth';
import { FakeClock, MINUTE } from '../../core/time';
import {
  CHALLENGE_TTL_MS,
  PlayIntegrityVerifier,
  challengeIsValid,
  integrityMock,
  integrityOff,
  issueChallenge,
} from './integrity';

const SECRET = 'a-secret-that-is-long-enough-for-tests-0123456789';
const PACKAGE = 'za.co.example.calories';

describe('challenges', () => {
  it('are accepted until they expire, and only if untouched', async () => {
    const clock = new FakeClock(T0);
    const { challenge, expiresAt } = await issueChallenge(SECRET, clock);
    expect(expiresAt).toBe(T0 + CHALLENGE_TTL_MS);
    expect(await challengeIsValid(SECRET, clock, challenge)).toBe(true);
    expect(await challengeIsValid('another-secret-another-secret-0123456789', clock, challenge)).toBe(false);
    const [rand, exp, sig] = challenge.split('.') as [string, string, string];
    expect(await challengeIsValid(SECRET, clock, `${rand}.${Number(exp) + 1}.${sig}`)).toBe(false);
    expect(await challengeIsValid(SECRET, clock, `x${rand}.${exp}.${sig}`)).toBe(false);
    clock.advance(CHALLENGE_TTL_MS + 1);
    expect(await challengeIsValid(SECRET, clock, challenge)).toBe(false);
  });
  it('reject junk', async () => {
    const clock = new FakeClock(T0);
    for (const bad of [null, '', 'abc', 'a.b', 'a.b.c', 'a.b.c.d', `a.NaN.c`, 'x'.repeat(500)])
      expect(await challengeIsValid(SECRET, clock, bad)).toBe(false);
  });
  it('are different every time', async () => {
    const clock = new FakeClock(T0);
    expect((await issueChallenge(SECRET, clock)).challenge).not.toBe(
      (await issueChallenge(SECRET, clock)).challenge,
    );
  });
});

describe('the simple verifiers', () => {
  it('off passes everything; the mock wants its one token', async () => {
    expect(integrityOff.required).toBe(false);
    expect(await integrityOff.verify(null, null)).toBe(true);
    expect(integrityMock.required).toBe(true);
    expect(await integrityMock.verify('mock-integrity-ok', null)).toBe(true);
    expect(await integrityMock.verify('nope', null)).toBe(false);
    expect(await integrityMock.verify(null, null)).toBe(false);
  });
});

async function playVerifier(
  verdict: unknown,
  opts: { decodeStatus?: number; decodeThrows?: boolean; pkg?: string | undefined } = {},
) {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const json = JSON.stringify({
    client_email: 'svc@x.iam.gserviceaccount.com',
    private_key: await exportPKCS8(privateKey),
  });
  const clock = new FakeClock(T0);
  const seen: Array<{ url: string; auth?: string; body?: string }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    if (url.includes('oauth2'))
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    seen.push({
      url,
      auth: (init.headers as Record<string, string>).authorization,
      body: init.body as string,
    });
    if (opts.decodeThrows) throw new Error('offline');
    return new Response(JSON.stringify(verdict), { status: opts.decodeStatus ?? 200 });
  }) as unknown as typeof fetch;
  const auth = new GoogleServiceAccountAuth(json, clock, fetcher);
  const pkg = 'pkg' in opts ? opts.pkg : PACKAGE;
  const verifier = new PlayIntegrityVerifier(auth, pkg, SECRET, clock, fetcher);
  const { challenge } = await issueChallenge(SECRET, clock);
  return { verifier, challenge, seen, clock };
}
const good = (nonce: string) => ({
  tokenPayloadExternal: {
    requestDetails: { requestPackageName: PACKAGE, nonce },
    appIntegrity: { appRecognitionVerdict: 'PLAY_RECOGNIZED' },
    deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_BASIC_INTEGRITY', 'MEETS_DEVICE_INTEGRITY'] },
  },
});

describe('PlayIntegrityVerifier', () => {
  it('accepts a recognised app on a genuine device that answered our challenge, and checks every part of the verdict', async () => {
    const verdictFor = (c: string) => good(c);
    // Build verifier whose fetcher echoes a verdict for the real challenge
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const json = JSON.stringify({
      client_email: 'svc@x.iam.gserviceaccount.com',
      private_key: await exportPKCS8(privateKey),
    });
    const clock = new FakeClock(T0);
    const { challenge } = await issueChallenge(SECRET, clock);
    let verdict: unknown = verdictFor(challenge);
    const calls: Array<{ url: string; auth: string; body: string }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      if (url.includes('oauth2'))
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      calls.push({
        url,
        auth: (init.headers as Record<string, string>).authorization!,
        body: init.body as string,
      });
      return new Response(JSON.stringify(verdict));
    }) as unknown as typeof fetch;
    const verifier = new PlayIntegrityVerifier(
      new GoogleServiceAccountAuth(json, clock, fetcher),
      PACKAGE,
      SECRET,
      clock,
      fetcher,
    );

    expect(await verifier.verify('device-token', challenge)).toBe(true);
    expect(calls[0]).toEqual({
      url: `https://playintegrity.googleapis.com/v1/${PACKAGE}:decodeIntegrityToken`,
      auth: 'Bearer tok',
      body: JSON.stringify({ integrity_token: 'device-token' }),
    });

    const mutate = (fn: (p: any) => void) => {
      const v = structuredClone(verdictFor(challenge)) as any;
      fn(v.tokenPayloadExternal);
      return v;
    };
    for (const bad of [
      mutate((p) => (p.requestDetails.requestPackageName = 'evil.app')),
      mutate((p) => (p.requestDetails.nonce = 'other')),
      mutate((p) => (p.appIntegrity.appRecognitionVerdict = 'UNRECOGNIZED_VERSION')),
      mutate((p) => (p.deviceIntegrity.deviceRecognitionVerdict = ['MEETS_BASIC_INTEGRITY'])),
      mutate((p) => delete p.deviceIntegrity),
      {},
    ]) {
      verdict = bad;
      expect(await verifier.verify('device-token', challenge)).toBe(false);
    }
  });
  it('refuses without calling Google when the token or challenge is missing, expired or forged', async () => {
    const { verifier, challenge, seen, clock } = await playVerifier({});
    expect(await verifier.verify(null, challenge)).toBe(false);
    expect(await verifier.verify('t', null)).toBe(false);
    expect(await verifier.verify('t', 'forged.123.sig')).toBe(false);
    clock.advance(6 * MINUTE);
    expect(await verifier.verify('t', challenge)).toBe(false);
    expect(seen).toHaveLength(0);
  });
  it('says so when Google rejects the token, and when Google cannot be reached', async () => {
    const rejected = await playVerifier({}, { decodeStatus: 400 });
    expect(await rejected.verifier.verify('t', rejected.challenge)).toBe(false);
    const down = await playVerifier({}, { decodeThrows: true });
    await expect(down.verifier.verify('t', down.challenge)).rejects.toMatchObject({ status: 502 });
  });
  it('needs a package name and a service account', async () => {
    const noPkg = await playVerifier({}, { pkg: undefined });
    await expect(noPkg.verifier.verify('t', noPkg.challenge)).rejects.toMatchObject({ status: 501 });
    const clock = new FakeClock(T0);
    const { challenge } = await issueChallenge(SECRET, clock);
    const noAccount = new PlayIntegrityVerifier(
      new GoogleServiceAccountAuth(undefined, clock),
      PACKAGE,
      SECRET,
      clock,
    );
    await expect(noAccount.verify('t', challenge)).rejects.toMatchObject({ status: 501 });
  });
});

describe('enforcement on account creation', () => {
  it('stays off by default', async () => {
    const t = makeApp();
    const ch = await body(await t.request('/v1/auth/challenge'));
    expect(ch.required).toBe(false);
    expect((await t.request('/v1/auth/anonymous', jsonInit('POST', {}))).status).toBe(201);
  });
  it('blocks account creation without proof when switched on, and lets the proof through', async () => {
    const t = makeApp({ integrity: integrityMock });
    expect((await body(await t.request('/v1/auth/challenge'))).required).toBe(true);
    const denied = await t.request('/v1/auth/anonymous', jsonInit('POST', {}));
    expect(denied.status).toBe(403);
    expect((await body(denied)).error.code).toBe('integrity_failed');
    const wrong = await t.request(
      '/v1/auth/anonymous',
      jsonInit('POST', {}, undefined, { 'x-integrity-token': 'x' }),
    );
    expect(wrong.status).toBe(403);
    const ok = await t.request(
      '/v1/auth/anonymous',
      jsonInit('POST', {}, undefined, { 'x-integrity-token': 'mock-integrity-ok' }),
    );
    expect(ok.status).toBe(201);
  });
  it('hands out challenges that verify', async () => {
    const t = makeApp();
    const ch = await body(await t.request('/v1/auth/challenge'));
    expect(await challengeIsValid(env.JWT_SECRET as string, t.clock, ch.challenge)).toBe(true);
  });
});
