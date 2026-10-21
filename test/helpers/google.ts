import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import type { Clock } from '../../src/core/time';
import { GoogleIdTokenVerifier } from '../../src/modules/auth/google';

export const GOOGLE_CLIENT = 'test-client.apps.googleusercontent.com';

/** A stand-in for Google: signs ID tokens with a key we hold, and a verifier that trusts exactly that key. */
export async function makeGoogle(clock: Clock) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const verifier = new GoogleIdTokenVerifier([GOOGLE_CLIENT], clock, createLocalJWKSet({ keys: [jwk] }));

  async function issue(
    claims: { sub: string; email?: string; email_verified?: boolean; name?: string },
    opts: { audience?: string; issuer?: string; expiresInSeconds?: number; key?: CryptoKey } = {},
  ) {
    const iat = Math.floor(clock.now() / 1000);
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(opts.issuer ?? 'https://accounts.google.com')
      .setAudience(opts.audience ?? GOOGLE_CLIENT)
      .setIssuedAt(iat)
      .setExpirationTime(iat + (opts.expiresInSeconds ?? 3600))
      .sign(opts.key ?? privateKey);
  }
  return { verifier, issue, privateKey };
}
