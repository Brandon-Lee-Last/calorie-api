import { exportPKCS8, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { FakeClock, MINUTE } from './time';
import { GoogleServiceAccountAuth } from './google-auth';

const T0 = Date.UTC(2026, 9, 21, 12);

async function account(extra: object = {}) {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  return JSON.stringify({
    client_email: 'svc@project.iam.gserviceaccount.com',
    private_key: await exportPKCS8(privateKey),
    ...extra,
  });
}

function fakeToken(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body as URLSearchParams });
    const next = responses.shift() ?? new Response('{}', { status: 500 });
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}
const ok = (token = 'ya29.token', expiresIn = 3600) =>
  new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }));

describe('GoogleServiceAccountAuth', () => {
  it('swaps a signed assertion for an access token, and reuses it until shortly before it expires', async () => {
    const clock = new FakeClock(T0);
    const { fetcher, calls } = fakeToken([ok('first'), ok('second')]);
    const auth = new GoogleServiceAccountAuth(await account(), clock, fetcher);
    expect(auth.configured).toBe(true);
    expect(auth.email).toBe('svc@project.iam.gserviceaccount.com');

    expect(await auth.token('scope-a')).toBe('first');
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token');
    expect(calls[0]!.body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const claims = JSON.parse(
      atob(calls[0]!.body.get('assertion')!.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')),
    );
    expect(claims).toMatchObject({ scope: 'scope-a', iss: 'svc@project.iam.gserviceaccount.com' });

    clock.advance(30 * MINUTE);
    expect(await auth.token('scope-a')).toBe('first'); // cached
    expect(calls).toHaveLength(1);
    clock.advance(30 * MINUTE); // within a minute of expiry: fetch a fresh one
    expect(await auth.token('scope-a')).toBe('second');
    expect(calls).toHaveLength(2);
  });
  it('keeps a token per scope', async () => {
    const { fetcher, calls } = fakeToken([ok('a'), ok('b')]);
    const auth = new GoogleServiceAccountAuth(await account(), new FakeClock(T0), fetcher);
    expect(await auth.token('one')).toBe('a');
    expect(await auth.token('two')).toBe('b');
    expect(await auth.token('one')).toBe('a');
    expect(calls).toHaveLength(2);
  });
  it('honours a custom token endpoint and a short lifetime', async () => {
    const clock = new FakeClock(T0);
    const { fetcher, calls } = fakeToken([ok('a', 90), ok('b')]);
    const auth = new GoogleServiceAccountAuth(
      await account({ token_uri: 'https://example.test/t' }),
      clock,
      fetcher,
    );
    await auth.token('s');
    expect(calls[0]!.url).toBe('https://example.test/t');
    clock.advance(30_000); // 60 s of life left is inside the one-minute safety margin
    expect(await auth.token('s')).toBe('b');
  });
  it('reports a missing or broken service account as not configured', async () => {
    for (const json of [undefined, '', 'not json', '{"client_email":"x"}', '{"private_key":"y"}']) {
      const auth = new GoogleServiceAccountAuth(json, new FakeClock(T0));
      expect(auth.configured).toBe(false);
      await expect(auth.token('s')).rejects.toMatchObject({ status: 501 });
      expect(() => auth.email).toThrow();
    }
  });
  it('turns every kind of Google failure into upstream_failed', async () => {
    const json = await account();
    for (const response of [
      new Error('network down'),
      new Response('no', { status: 401 }),
      new Response('{}'),
      new Response('{"expires_in":10}'),
    ]) {
      const { fetcher } = fakeToken([response]);
      const auth = new GoogleServiceAccountAuth(json, new FakeClock(T0), fetcher);
      await expect(auth.token('s')).rejects.toMatchObject({ status: 502, code: 'upstream_failed' });
    }
  });
});
