import { hmacSha256Base64Url, randomToken, timingSafeEqual } from '../../core/crypto';
import { notConfigured, AppError } from '../../core/errors';
import type { GoogleServiceAccountAuth } from '../../core/google-auth';
import type { Clock } from '../../core/time';
import { globalFetch } from '../../core/fetch';

export const CHALLENGE_TTL_MS = 5 * 60_000;

/**
 * Proof that a request comes from the real, unmodified app on a genuine device (Google Play Integrity). It is what stops
 * a script from creating thousands of accounts to dodge free limits. The app asks for a challenge, passes it to the Play
 * Integrity API as the "nonce", and sends the resulting token with the request.
 */
export interface IntegrityVerifier {
  readonly required: boolean;
  verify(token: string | null, challenge: string | null): Promise<boolean>;
}

/** Not enforcing: everything passes. */
export const integrityOff: IntegrityVerifier = { required: false, verify: async () => true };

/** For local and stage work: the token `mock-integrity-ok` passes, anything else fails. */
export const integrityMock: IntegrityVerifier = {
  required: true,
  verify: async (token) => token === 'mock-integrity-ok',
};

/** A challenge the server can recognise later without storing it: random part, expiry, and a signature over both. */
export async function issueChallenge(
  secret: string,
  clock: Clock,
): Promise<{ challenge: string; expiresAt: number }> {
  const expiresAt = clock.now() + CHALLENGE_TTL_MS;
  const body = `${randomToken(16)}.${expiresAt}`;
  return { challenge: `${body}.${await hmacSha256Base64Url(secret, `challenge:${body}`)}`, expiresAt };
}

export async function challengeIsValid(
  secret: string,
  clock: Clock,
  challenge: string | null,
): Promise<boolean> {
  if (!challenge || challenge.length > 200) return false;
  const parts = challenge.split('.');
  if (parts.length !== 3) return false;
  const [rand, exp, sig] = parts as [string, string, string];
  const expiresAt = Number(exp);
  if (!Number.isFinite(expiresAt) || expiresAt < clock.now()) return false;
  return timingSafeEqual(await hmacSha256Base64Url(secret, `challenge:${rand}.${exp}`), sig);
}

type Verdict = {
  tokenPayloadExternal?: {
    requestDetails?: { requestPackageName?: string; nonce?: string };
    appIntegrity?: { appRecognitionVerdict?: string; packageName?: string };
    deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
  };
};

/** Real Play Integrity check. Written from the API's documented response; needs a live Play project to prove. */
export class PlayIntegrityVerifier implements IntegrityVerifier {
  readonly required = true;
  constructor(
    private auth: GoogleServiceAccountAuth,
    private packageName: string | undefined,
    private secret: string,
    private clock: Clock,
    private fetcher: typeof fetch = globalFetch,
  ) {}

  async verify(token: string | null, challenge: string | null): Promise<boolean> {
    if (!token || !(await challengeIsValid(this.secret, this.clock, challenge))) return false;
    if (!this.packageName || !this.auth.configured) throw notConfigured('Play Integrity');
    const access = await this.auth.token('https://www.googleapis.com/auth/playintegrity');
    let res: Response;
    try {
      res = await this.fetcher(
        `https://playintegrity.googleapis.com/v1/${encodeURIComponent(this.packageName)}:decodeIntegrityToken`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
          body: JSON.stringify({ integrity_token: token }),
        },
      );
    } catch {
      throw new AppError(502, 'upstream_failed', 'The integrity service is not available right now');
    }
    if (!res.ok) return false; // Google rejected the token itself
    const p = ((await res.json()) as Verdict).tokenPayloadExternal;
    return (
      p?.requestDetails?.requestPackageName === this.packageName &&
      p?.requestDetails?.nonce === challenge &&
      p?.appIntegrity?.appRecognitionVerdict === 'PLAY_RECOGNIZED' &&
      (p?.deviceIntegrity?.deviceRecognitionVerdict ?? []).includes('MEETS_DEVICE_INTEGRITY')
    );
  }
}
