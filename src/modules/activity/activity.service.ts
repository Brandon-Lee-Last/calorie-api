import { conflict } from '../../core/errors';
import type { Clock } from '../../core/time';
import { assertLoggedTime, assertRangeWithin, sanitizeClientTime } from '../../core/validation';
import { estimateCalories, type ActivityKind } from '../../lib/activity';
import type { UsersRepo } from '../users/users.repo';
import type { ActivityRepo, ActivityRow } from './activity.repo';
import type { z } from '../../core/openapi';
import type { activityInputSchema } from './activity.schemas';

export type ActivityInput = z.infer<typeof activityInputSchema>;
export const MAX_RANGE_DAYS = 366;

export const toActivity = (r: ActivityRow) => ({
  id: r.id,
  loggedAt: r.logged_at,
  localDate: r.local_date,
  kind: r.kind as ActivityKind,
  name: r.name,
  durationMin: r.duration_min,
  steps: r.steps,
  distanceKm: r.distance_km,
  caloriesBurned: r.calories_burned,
  caloriesEstimated: r.calories_estimated === 1,
  note: r.note,
  clientUpdatedAt: r.client_updated_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
  rev: r.rev,
}); // fmt: skip

export class ActivityService {
  constructor(
    private repo: ActivityRepo,
    private users: UsersRepo,
    private clock: Clock,
  ) {}

  async put(userId: string, id: string, input: ActivityInput) {
    const now = this.clock.now();
    assertLoggedTime(input, now);
    if (await this.repo.taken(userId, id)) throw conflict('That id is already in use');
    const given = input.caloriesBurned ?? null;
    const duration = input.durationMin ?? null;
    // The person's own number is kept as they typed it. Otherwise estimate from their weight, and say so.
    const estimate =
      given === null
        ? estimateCalories(input.kind, duration, (await this.users.getProfile(userId))?.weight_kg ?? null)
        : null;
    const { applied } = await this.repo.upsert(
      userId,
      id,
      {
        loggedAt: input.loggedAt,
        localDate: input.localDate,
        kind: input.kind,
        name: input.name ?? null,
        durationMin: duration,
        steps: input.steps ?? null,
        distanceKm: input.distanceKm ?? null,
        caloriesBurned: given ?? estimate,
        caloriesEstimated: given === null && estimate !== null,
        note: input.note ?? null,
      },
      sanitizeClientTime(input.clientUpdatedAt, now),
      now,
    ); // fmt: skip
    return { applied, record: toActivity((await this.repo.get(userId, id))!) };
  }

  delete(userId: string, id: string, clientUpdatedAt?: number) {
    const now = this.clock.now();
    return this.repo.delete(
      userId,
      id,
      clientUpdatedAt === undefined ? now : sanitizeClientTime(clientUpdatedAt, now),
      now,
      clientUpdatedAt === undefined, // a direct DELETE is the person acting now: always applies
    );
  }

  async list(userId: string, from: string, to: string) {
    assertRangeWithin(from, to, MAX_RANGE_DAYS);
    const rows = await this.repo.list(userId, from, to);
    const totalsByDate: Record<string, { minutes: number; caloriesBurned: number; steps: number }> = {};
    for (const r of rows) {
      const t = (totalsByDate[r.local_date] ??= { minutes: 0, caloriesBurned: 0, steps: 0 });
      t.minutes += r.duration_min ?? 0;
      t.caloriesBurned += r.calories_burned ?? 0;
      t.steps += r.steps ?? 0;
    }
    return { items: rows.map(toActivity), totalsByDate };
  }
}
