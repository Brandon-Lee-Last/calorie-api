import { conflict } from '../../core/errors';
import type { Clock } from '../../core/time';
import { assertLoggedTime, assertRangeWithin, sanitizeClientTime } from '../../core/validation';
import type { UsersService } from '../users/users.service';
import type { BodyRepo, WaterRow, WeightRow } from './body.repo';

export const MAX_RANGE_DAYS = 366;

export const toWeight = (r: WeightRow) => ({
  id: r.id,
  loggedAt: r.logged_at,
  localDate: r.local_date,
  weightKg: r.weight_kg,
  note: r.note,
  clientUpdatedAt: r.client_updated_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
  rev: r.rev,
}); // fmt: skip
export const toWater = (r: WaterRow) => ({
  id: r.id,
  loggedAt: r.logged_at,
  localDate: r.local_date,
  ml: r.ml,
  clientUpdatedAt: r.client_updated_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
  rev: r.rev,
}); // fmt: skip

export type WeightInput = {
  loggedAt: number;
  localDate: string;
  weightKg: number;
  note?: string | null;
  clientUpdatedAt: number;
};
export type WaterInput = { loggedAt: number; localDate: string; ml: number; clientUpdatedAt: number };

export class BodyService {
  constructor(
    private repo: BodyRepo,
    private users: UsersService,
    private clock: Clock,
  ) {}

  async putWeight(userId: string, id: string, input: WeightInput) {
    const now = this.clock.now();
    assertLoggedTime(input, now);
    if (await this.repo.takenWeight(userId, id)) throw conflict('That id is already in use');
    const { applied } = await this.repo.upsertWeight(
      userId,
      id,
      {
        loggedAt: input.loggedAt,
        localDate: input.localDate,
        weightKg: input.weightKg,
        note: input.note ?? null,
      },
      sanitizeClientTime(input.clientUpdatedAt, now),
      now,
    ); // fmt: skip
    if (applied) await this.syncProfileWeight(userId);
    return { applied, record: toWeight((await this.repo.getWeight(userId, id))!) };
  }

  async deleteWeight(userId: string, id: string, clientUpdatedAt?: number) {
    const now = this.clock.now();
    const result = await this.repo.deleteWeight(
      userId,
      id,
      clientUpdatedAt === undefined ? now : sanitizeClientTime(clientUpdatedAt, now),
      now,
    );
    if (result.outcome === 'applied') await this.syncProfileWeight(userId);
    return result;
  }

  async listWeight(userId: string, from: string, to: string) {
    assertRangeWithin(from, to, MAX_RANGE_DAYS);
    return { items: (await this.repo.listWeight(userId, from, to)).map(toWeight) };
  }

  /** The profile's current weight is the newest log, so goals follow what the person actually weighs. */
  private async syncProfileWeight(userId: string) {
    const latest = await this.repo.latestWeight(userId);
    if (latest) await this.users.setCurrentWeight(userId, latest.weight_kg);
  }

  async putWater(userId: string, id: string, input: WaterInput) {
    const now = this.clock.now();
    assertLoggedTime(input, now);
    if (await this.repo.takenWater(userId, id)) throw conflict('That id is already in use');
    const { applied } = await this.repo.upsertWater(
      userId,
      id,
      { loggedAt: input.loggedAt, localDate: input.localDate, ml: input.ml },
      sanitizeClientTime(input.clientUpdatedAt, now),
      now,
    ); // fmt: skip
    return { applied, record: toWater((await this.repo.getWater(userId, id))!) };
  }

  deleteWater(userId: string, id: string, clientUpdatedAt?: number) {
    const now = this.clock.now();
    return this.repo.deleteWater(
      userId,
      id,
      clientUpdatedAt === undefined ? now : sanitizeClientTime(clientUpdatedAt, now),
      now,
    );
  }

  async listWater(userId: string, from: string, to: string) {
    assertRangeWithin(from, to, MAX_RANGE_DAYS);
    const rows = await this.repo.listWater(userId, from, to);
    const totalsByDate: Record<string, number> = {};
    for (const r of rows) totalsByDate[r.local_date] = (totalsByDate[r.local_date] ?? 0) + r.ml;
    return { items: rows.map(toWater), totalsByDate };
  }
}
