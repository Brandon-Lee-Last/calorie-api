import { SignJWT, jwtVerify, errors } from 'jose';
import { tokenExpired, unauthorized } from '../../core/errors';
import type { Clock } from '../../core/time';

export const ACCESS_TTL_SECONDS = 15 * 60;
const ISSUER = 'calorie-api';
const AUDIENCE = 'calorie-app';

export type AccessClaims = { userId: string; sessionId: string; expiresAt: number };

/** Signs and checks the short-lived access JWT. Refresh tokens are not JWTs; see auth.service.ts. */
export class TokenService {
  private key: Uint8Array;

  constructor(
    secret: string,
    private clock: Clock,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  async signAccess(userId: string, sessionId: string): Promise<{ token: string; expiresIn: number }> {
    const iat = Math.floor(this.clock.now() / 1000);
    const token = await new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ACCESS_TTL_SECONDS)
      .sign(this.key);
    return { token, expiresIn: ACCESS_TTL_SECONDS };
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
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
      throw unauthorized('The access token is not valid');
    }
  }
}
