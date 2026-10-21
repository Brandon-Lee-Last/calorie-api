import { SignJWT, decodeProtectedHeader, errors, jwtVerify } from 'jose';
import { sha256Hex } from '../../core/crypto';
import { tokenExpired, unauthorized } from '../../core/errors';
import type { Clock } from '../../core/time';

export const ACCESS_TTL_SECONDS = 15 * 60;
const ISSUER = 'calorie-api';
const AUDIENCE = 'calorie-app';

export type AccessClaims = { userId: string; sessionId: string; expiresAt: number };

/** Short, non-secret name for a signing key, so a token says which key signed it. */
async function keyId(secret: string): Promise<string> {
  return (await sha256Hex(`kid:${secret}`)).slice(0, 12);
}

type Key = { kid: string; key: Uint8Array };

/**
 * Signs and checks the short-lived access JWT. Refresh tokens are not JWTs; see auth.service.ts.
 *
 * Rotating the secret without signing everyone out: set the new value as JWT_SECRET and move the old one to
 * JWT_SECRET_PREVIOUS. New tokens are signed with the new key; tokens signed with the old key still verify until they expire
 * (15 minutes), after which the previous secret can be removed.
 */
export class TokenService {
  private keys: Promise<Key[]>;

  constructor(
    secret: string,
    private clock: Clock,
    previous?: string,
  ) {
    const enc = new TextEncoder();
    this.keys = Promise.all(
      [secret, ...(previous && previous !== secret ? [previous] : [])].map(async (s) => ({
        kid: await keyId(s),
        key: enc.encode(s),
      })),
    );
  }

  async signAccess(userId: string, sessionId: string): Promise<{ token: string; expiresIn: number }> {
    const [current] = await this.keys;
    const iat = Math.floor(this.clock.now() / 1000);
    const token = await new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT', kid: current!.kid })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ACCESS_TTL_SECONDS)
      .sign(current!.key);
    return { token, expiresIn: ACCESS_TTL_SECONDS };
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    const keys = await this.keys;
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(token).kid;
    } catch {
      throw unauthorized('The access token is not valid');
    }
    // A token names its key; one that names none (or an unknown one) is tried against every key we hold.
    const named = keys.filter((k) => k.kid === kid);
    let failure: unknown;
    for (const k of named.length ? named : keys) {
      try {
        const { payload } = await jwtVerify(token, k.key, {
          issuer: ISSUER,
          audience: AUDIENCE,
          algorithms: ['HS256'],
          currentDate: new Date(this.clock.now()),
        });
        const sid = payload.sid;
        if (!payload.sub || typeof sid !== 'string' || !payload.exp)
          throw unauthorized('The access token is malformed');
        return { userId: payload.sub, sessionId: sid, expiresAt: payload.exp * 1000 };
      } catch (e) {
        if (e instanceof errors.JWTExpired) throw tokenExpired();
        if (e instanceof Error && e.name === 'AppError') throw e;
        failure = e;
      }
    }
    void failure;
    throw unauthorized('The access token is not valid');
  }
}
