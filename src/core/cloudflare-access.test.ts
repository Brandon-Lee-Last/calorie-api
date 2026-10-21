import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { FakeClock } from './time';
import { CloudflareAccessVerifier } from './cloudflare-access';

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'a'.repeat(64);

async function setup() {
  const clock = new FakeClock(Date.UTC(2026, 9, 21, 12));
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const verifier = new CloudflareAccessVerifier(TEAM, AUD, clock, createLocalJWKSet({ keys: [jwk] }));
  const issue = async (
    claims: Record<string, unknown> = { email: 'me@example.com' },
    o: { aud?: string; iss?: string; ttl?: number; key?: CryptoKey } = {},
  ) => {
    const iat = Math.floor(clock.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(o.iss ?? `https://${TEAM}`)
      .setAudience(o.aud ?? AUD)
      .setIssuedAt(iat)
      .setExpirationTime(iat + (o.ttl ?? 300))
      .sign(o.key ?? privateKey);
  };
  return { verifier, issue, clock };
}

describe('CloudflareAccessVerifier', () => {
  it('returns the email of whoever Access let in', async () => {
    const { verifier, issue } = await setup();
    expect(await verifier.verify(await issue())).toBe('me@example.com');
  });
  it('falls back to the subject for service tokens', async () => {
    const { verifier, issue } = await setup();
    expect(await verifier.verify(await issue({ sub: 'service-token-1' }))).toBe('service-token-1');
  });
  it('refuses everything else with 403', async () => {
    const { verifier, issue, clock } = await setup();
    const other = (await generateKeyPair('RS256')).privateKey;
    const bad = [
      undefined,
      '',
      'not.a.jwt',
      await issue({ email: 'a@b.co' }, { aud: 'someone else' }),
      await issue({ email: 'a@b.co' }, { iss: 'https://evil.cloudflareaccess.com' }),
      await issue({ email: 'a@b.co' }, { key: other }),
      await issue({}, {}), // no identity at all
    ];
    for (const token of bad) await expect(verifier.verify(token)).rejects.toMatchObject({ status: 403 });
    const old = await issue();
    clock.advance(10 * 60_000);
    await expect(verifier.verify(old)).rejects.toMatchObject({ status: 403 });
  });
});
