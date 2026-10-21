import { conflict, unauthorized } from '../../core/errors';
import { randomToken, sha256Hex } from '../../core/crypto';
import { newId } from '../../core/ids';
import { DAY, type Clock } from '../../core/time';
import type { GoogleVerifier } from './google';
import type { AuthRepo } from './auth.repo';
import type { TokenService } from './tokens';

export const REFRESH_TTL_MS = 90 * DAY;
/** A client whose refresh response was lost will retry with the old token; allow that briefly instead of signing it out. */
export const REFRESH_REUSE_GRACE_MS = 10_000;

export type Session = {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  userId: string;
  isAnonymous: boolean;
};

export type GoogleSignInResult = Session & { linked: boolean; created: boolean };

export class AuthService {
  constructor(
    private repo: AuthRepo,
    private tokens: TokenService,
    private google: GoogleVerifier,
    private clock: Clock,
  ) {}

  /** A new account with no sign-in method. The refresh token is its only credential, so the app must keep it safe. */
  async registerAnonymous(deviceLabel: string | null): Promise<Session> {
    const now = this.clock.now();
    const userId = newId(now);
    await this.repo.createUser({ id: userId, now });
    return this.startSession(userId, newId(now), deviceLabel);
  }

  async signInWithGoogle(input: {
    idToken: string;
    currentUserId: string | null;
    discardAnonymousData: boolean;
    deviceLabel: string | null;
  }): Promise<GoogleSignInResult> {
    const g = await this.google.verify(input.idToken);
    const email = g.emailVerified ? g.email : null;
    const now = this.clock.now();

    let existing = await this.repo.findIdentity('google', g.subject);
    if (existing && !(await this.repo.findUser(existing.user_id))) {
      // The account this identity belonged to was deleted. Free the identity so the person can start again.
      await this.repo.deleteIdentity(existing.id);
      existing = null;
    }

    if (existing) {
      if (input.currentUserId && input.currentUserId !== existing.user_id) {
        const callerIsAnonymous = (await this.repo.listIdentities(input.currentUserId)).length === 0;
        if (callerIsAnonymous && !input.discardAnonymousData) {
          throw conflict(
            'This Google account already has data. Signing in will leave this device’s data behind.',
            {
              reason: 'identity_in_use',
            },
          );
        }
      }
      await this.repo.fillMissingProfile(existing.user_id, email, g.name, now);
      const session = await this.startSession(existing.user_id, newId(now), input.deviceLabel);
      return { ...session, linked: false, created: false };
    }

    const current = input.currentUserId ? await this.repo.findUser(input.currentUserId) : null;
    if (current) {
      if ((await this.repo.listIdentities(current.id)).length > 0) {
        throw conflict('This account is already linked to a different Google account', {
          reason: 'already_linked',
        });
      }
      await this.repo.addIdentity({
        id: newId(now),
        userId: current.id,
        provider: 'google',
        subject: g.subject,
        email,
        now,
      });
      await this.repo.fillMissingProfile(current.id, email, g.name, now);
      const session = await this.startSession(current.id, newId(now), input.deviceLabel);
      return { ...session, linked: true, created: false };
    }

    const userId = newId(now);
    await this.repo.createUser({ id: userId, now, email, displayName: g.name });
    await this.repo.addIdentity({
      id: newId(now),
      userId,
      provider: 'google',
      subject: g.subject,
      email,
      now,
    });
    const session = await this.startSession(userId, newId(now), input.deviceLabel);
    return { ...session, linked: false, created: true };
  }

  /**
   * Swap a refresh token for a new pair. The old token becomes single-use: presenting it again after the grace
   * window means it was copied, so the whole sign-in (family) is revoked.
   */
  async refresh(rawToken: string): Promise<Session> {
    const now = this.clock.now();
    const row = await this.repo.findRefresh(await sha256Hex(rawToken));
    if (!row || row.revoked_at !== null) throw unauthorized('The refresh token is not valid');
    if (row.expires_at <= now) throw unauthorized('The refresh token has expired, sign in again');

    if (row.used_at !== null && now - row.used_at > REFRESH_REUSE_GRACE_MS) {
      await this.repo.revokeFamily(row.family_id, now);
      throw unauthorized('This refresh token was already used, so the session was ended. Sign in again.');
    }
    if (!(await this.repo.findUser(row.user_id))) {
      await this.repo.revokeFamily(row.family_id, now);
      throw unauthorized('This account no longer exists');
    }
    if (row.used_at === null) await this.repo.markRefreshUsed(row.id, now);
    return this.startSession(row.user_id, row.family_id, row.device_label);
  }

  /** Ends the sign-in this refresh token belongs to. Unknown tokens are ignored so logging out is always safe to retry. */
  async logout(rawToken: string): Promise<void> {
    const row = await this.repo.findRefresh(await sha256Hex(rawToken));
    if (row) await this.repo.revokeFamily(row.family_id, this.clock.now());
  }

  async logoutAll(userId: string): Promise<void> {
    await this.repo.revokeAllForUser(userId, this.clock.now());
  }

  verifyAccess(token: string) {
    return this.tokens.verifyAccess(token);
  }

  private async startSession(userId: string, familyId: string, deviceLabel: string | null): Promise<Session> {
    const now = this.clock.now();
    const refreshToken = randomToken(32);
    await this.repo.insertRefresh({
      id: newId(now),
      user_id: userId,
      family_id: familyId,
      token_hash: await sha256Hex(refreshToken),
      device_label: deviceLabel,
      created_at: now,
      expires_at: now + REFRESH_TTL_MS,
    });
    const access = await this.tokens.signAccess(userId, familyId);
    const isAnonymous = (await this.repo.listIdentities(userId)).length === 0;
    return {
      accessToken: access.token,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
      userId,
      isAnonymous,
    };
  }
}
