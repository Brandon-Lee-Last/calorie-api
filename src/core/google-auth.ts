import { SignJWT, importPKCS8 } from 'jose';
import { notConfigured, upstreamFailed } from './errors';
import type { Clock } from './time';
import { globalFetch } from './fetch';

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };

/**
 * Signs in to Google APIs as a service account: signs a short JWT with the account's private key and swaps it for an access
 * token, which it keeps until shortly before it expires. Used for Google Play billing, Play Integrity and Firebase messaging.
 */
export class GoogleServiceAccountAuth {
  private cached = new Map<string, { token: string; expiresAt: number }>();
  private account: ServiceAccount | null;

  constructor(
    json: string | undefined,
    private clock: Clock,
    private fetcher: typeof fetch = globalFetch,
  ) {
    this.account = parse(json);
  }

  get configured(): boolean {
    return this.account !== null;
  }

  get email(): string {
    return this.requireAccount().client_email;
  }

  async token(scope: string): Promise<string> {
    const account = this.requireAccount();
    const now = this.clock.now();
    const hit = this.cached.get(scope);
    if (hit && hit.expiresAt - 60_000 > now) return hit.token;

    const iat = Math.floor(now / 1000);
    const tokenUri = account.token_uri ?? 'https://oauth2.googleapis.com/token';
    const assertion = await new SignJWT({ scope })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(account.client_email)
      .setSubject(account.client_email)
      .setAudience(tokenUri)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 3600)
      .sign(await importPKCS8(account.private_key, 'RS256'));

    let res: Response;
    try {
      res = await this.fetcher(tokenUri, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      });
    } catch {
      throw upstreamFailed('Google sign-in for services');
    }
    if (!res.ok) throw upstreamFailed('Google sign-in for services');
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw upstreamFailed('Google sign-in for services');
    this.cached.set(scope, { token: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000 });
    return body.access_token;
  }

  private requireAccount(): ServiceAccount {
    if (!this.account) throw notConfigured('Google service account');
    return this.account;
  }
}

function parse(json: string | undefined): ServiceAccount | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Partial<ServiceAccount>;
    return typeof v.client_email === 'string' && typeof v.private_key === 'string'
      ? (v as ServiceAccount)
      : null;
  } catch {
    return null;
  }
}
