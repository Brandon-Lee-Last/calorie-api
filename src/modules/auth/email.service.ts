import { hmacSha256Base64Url, timingSafeEqual } from '../../core/crypto';
import { invalidCode } from '../../core/errors';
import { newId } from '../../core/ids';
import { DAY, MINUTE, type Clock } from '../../core/time';
import type { Logger } from '../../core/logger';
import type { EmailCodesRepo } from './email.repo';
import type { Mailer } from './mailer';

export const CODE_TTL_MS = 10 * MINUTE;
/** Wrong guesses allowed per code. A six digit code has a million values, so five guesses is a 1 in 200,000 shot. */
export const MAX_CODE_ATTEMPTS = 5;
export const RESEND_COOLDOWN_MS = 60_000;
/** Most codes one address can be sent in a day, so the form cannot be used to flood someone's inbox. */
export const MAX_CODES_PER_DAY = 10;

export const normaliseEmail = (email: string) => email.trim().toLowerCase();

/** A uniformly random six digit code (rejection sampling, so no digit is likelier than another). */
export function generateCode(
  random: (n: number) => Uint32Array = (n) => crypto.getRandomValues(new Uint32Array(n)),
): string {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  for (;;) {
    const [n] = random(1);
    if (n! < limit) return String(n! % 1_000_000).padStart(6, '0');
  }
}

/**
 * Sends and checks one-time sign-in codes. Nothing here says whether an address already has an account, and neither the
 * address nor the code is stored in the clear.
 */
export class EmailCodeService {
  constructor(
    private repo: EmailCodesRepo,
    private mailer: Mailer,
    private secret: string,
    private clock: Clock,
    private logger: Logger,
  ) {}

  private emailHash(email: string) {
    return hmacSha256Base64Url(this.secret, `email:${email}`);
  }
  private codeHash(id: string, code: string) {
    return hmacSha256Base64Url(this.secret, `code:${id}:${code}`);
  }

  /** Always looks the same from outside. Too-frequent requests are quietly skipped instead of reported. */
  async start(rawEmail: string): Promise<void> {
    const email = normaliseEmail(rawEmail);
    const now = this.clock.now();
    const emailHash = await this.emailHash(email);

    const latest = await this.repo.latest(emailHash);
    if (latest && now - latest.created_at < RESEND_COOLDOWN_MS) return;
    if ((await this.repo.countSince(emailHash, now - DAY)) >= MAX_CODES_PER_DAY) {
      this.logger.warn('email code limit reached for an address');
      return;
    }

    const id = newId(now);
    const code = generateCode();
    await this.repo.issue({
      id,
      emailHash,
      codeHash: await this.codeHash(id, code),
      now,
      expiresAt: now + CODE_TTL_MS,
    });
    try {
      await this.mailer.send({
        to: email,
        subject: `Your sign-in code is ${code}`,
        text:
          `Your sign-in code is ${code}\n\nIt works for 10 minutes and only once. ` +
          `If you did not ask for it, you can ignore this email: nobody can sign in without the code.`,
      });
    } catch (e) {
      await this.repo.discard(id); // a code nobody received must not count against the person
      throw e;
    }
  }

  /** Spends the code. Every failure looks the same, so nothing leaks about which part was wrong. */
  async verify(rawEmail: string, code: string): Promise<string> {
    const email = normaliseEmail(rawEmail);
    const now = this.clock.now();
    const row = await this.repo.takeAttempt(await this.emailHash(email), now, MAX_CODE_ATTEMPTS);
    if (!row) throw invalidCode();
    if (!timingSafeEqual(await this.codeHash(row.id, code), row.code_hash)) throw invalidCode();
    if (!(await this.repo.consume(row.id, now))) throw invalidCode(); // someone else used it a moment ago
    return email;
  }
}
