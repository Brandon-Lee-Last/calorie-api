import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { forbidden } from './errors';
import type { Clock } from './time';

/**
 * Cloudflare Access sits in front of the admin paths and signs a JWT into `Cf-Access-Jwt-Assertion` for every request it lets
 * through. Checking it here means the admin API is still safe if someone reaches the Worker some other way (a leaked admin key
 * is not enough on its own).
 */
export interface AccessVerifier {
  /** Returns who signed in (their email). Throws 403 if the assertion is missing, forged, expired or for another application. */
  verify(assertion: string | undefined): Promise<string>;
}

export class CloudflareAccessVerifier implements AccessVerifier {
  constructor(
    private teamDomain: string,
    private audience: string,
    private clock: Clock,
    private getKey: JWTVerifyGetKey = createRemoteJWKSet(
      new URL(`https://${teamDomain}/cdn-cgi/access/certs`),
    ),
  ) {}

  async verify(assertion: string | undefined): Promise<string> {
    if (!assertion) throw forbidden('Sign in through Cloudflare Access to use the admin API');
    try {
      const { payload } = await jwtVerify(assertion, this.getKey, {
        issuer: `https://${this.teamDomain}`,
        audience: this.audience,
        algorithms: ['RS256'],
        currentDate: new Date(this.clock.now()),
      });
      const who = typeof payload.email === 'string' ? payload.email : payload.sub;
      if (!who) throw new Error('no identity');
      return who;
    } catch {
      throw forbidden('Cloudflare Access did not accept this request');
    }
  }
}
