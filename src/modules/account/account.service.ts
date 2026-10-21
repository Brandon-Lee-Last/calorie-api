import { notFound } from '../../core/errors';
import type { Clock } from '../../core/time';
import type { ObjectStorage } from '../media/object-storage';
import type { AccountRepo } from './account.repo';

/** snake_case column names to camelCase, and drop internal bookkeeping columns, for a readable export. */
const INTERNAL = new Set(['user_id', 'rev', 'client_updated_at', 'photo_key', 'image_key', 'name_norm']);
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
export function tidy(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (INTERNAL.has(k)) continue;
    out[camel(k)] = v;
  }
  if ('photo_key' in row) out.hasPhoto = row.photo_key !== null;
  return out;
}

export class AccountService {
  constructor(
    private repo: AccountRepo,
    private storage: ObjectStorage,
    private clock: Clock,
    private activePro: (userId: string) => Promise<{ plan: string }>,
  ) {}

  /** A copy of everything held about the person, as JSON they can keep. */
  async export(userId: string) {
    const user = await this.repo.user(userId);
    if (!user) throw notFound('Account');
    const [profile, identities, diary, weight, water, foods, scans, sessions, subscriptions, enrollments] =
      await Promise.all([
        this.repo.profile(userId),
        this.repo.identities(userId),
        this.repo.diary(userId),
        this.repo.weight(userId),
        this.repo.water(userId),
        this.repo.foods(userId),
        this.repo.scans(userId),
        this.repo.sessions(userId),
        this.repo.subscriptions(userId),
        this.repo.enrollments(userId),
      ]); // fmt: skip
    return {
      format: 1,
      exportedAt: this.clock.now(),
      account: tidy(user),
      profile: profile ? tidy(profile) : null,
      signInMethods: identities.map(tidy),
      diaryEntries: diary.map(tidy),
      weightLogs: weight.map(tidy),
      waterLogs: water.map(tidy),
      customFoods: foods.map(tidy),
      scanEvents: scans.map(tidy),
      workoutSessions: sessions.map((s) => ({ ...tidy(s), sets: safeJson(s.sets) })),
      subscriptions: subscriptions.map(tidy),
      programEnrollments: enrollments.map(tidy),
    };
  }

  /**
   * Erase the account: stored photos first, then the account row, which removes everything that belongs to it. This is
   * permanent. A subscription bought in an app store keeps billing until the person cancels it there, so say so.
   */
  async delete(userId: string) {
    const plan = (await this.activePro(userId)).plan;
    await this.storage.deletePrefix(`users/${userId}/`);
    await this.storage.deletePrefix(`contrib/${userId}/`);
    if (!(await this.repo.deleteUser(userId))) throw notFound('Account');
    return {
      deleted: true as const,
      subscriptionNote:
        plan === 'pro'
          ? 'Your subscription is billed by the app store and is not cancelled by deleting the account. Cancel it in the store to stop charges.'
          : null,
    };
  }
}

function safeJson(text: unknown): unknown {
  try {
    return JSON.parse(String(text));
  } catch {
    return [];
  }
}
