import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { notConfigured, unauthorized } from '../../core/errors';
import type { Clock } from '../../core/time';

export type GoogleIdentity = {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
};

export interface GoogleVerifier {
  verify(idToken: string): Promise<GoogleIdentity>;
}

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * Checks a Google ID token (from Google Sign-In on the phone): signature against Google's published keys,
 * issuer, audience (our OAuth client ids) and expiry. `getKey` is injectable so tests can use their own keys.
 */
export class GoogleIdTokenVerifier implements GoogleVerifier {
  constructor(
    private clientIds: string[],
    private clock: Clock,
    private getKey: JWTVerifyGetKey = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL)),
  ) {}

  async verify(idToken: string): Promise<GoogleIdentity> {
    if (this.clientIds.length === 0) throw notConfigured('Google sign-in');
    try {
      const { payload } = await jwtVerify(idToken, this.getKey, {
        issuer: GOOGLE_ISSUERS,
        audience: this.clientIds,
        algorithms: ['RS256'],
        currentDate: new Date(this.clock.now()),
      });
      if (!payload.sub) throw new Error('no subject');
      return {
        subject: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : null,
        emailVerified: payload.email_verified === true,
        name: typeof payload.name === 'string' ? payload.name : null,
      };
    } catch {
      throw unauthorized('The Google sign-in token is not valid');
    }
  }
}
