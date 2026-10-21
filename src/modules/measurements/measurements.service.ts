import { conflict } from '../../core/errors';
import type { Clock } from '../../core/time';
import { assertLoggedTime, assertRangeWithin, sanitizeClientTime } from '../../core/validation';
import { RANGES, type MeasurementType, type measurementInputSchema } from './measurements.schemas';
import type { MeasurementRow, MeasurementsRepo } from './measurements.repo';
import type { z } from '../../core/openapi';

export type MeasurementInput = z.infer<typeof measurementInputSchema>;
export const MAX_RANGE_DAYS = 366;

export const toMeasurement = (r: MeasurementRow) => ({
  id: r.id,
  loggedAt: r.logged_at,
  localDate: r.local_date,
  type: r.type as MeasurementType,
  value: r.value,
  unit: RANGES[r.type as MeasurementType].unit,
  note: r.note,
  clientUpdatedAt: r.client_updated_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
  rev: r.rev,
}); // fmt: skip

export class MeasurementsService {
  constructor(
    private repo: MeasurementsRepo,
    private clock: Clock,
  ) {}

  async put(userId: string, id: string, input: MeasurementInput) {
    const now = this.clock.now();
    assertLoggedTime(input, now);
    if (await this.repo.taken(userId, id)) throw conflict('That id is already in use');
    const { applied } = await this.repo.upsert(
      userId,
      id,
      {
        loggedAt: input.loggedAt,
        localDate: input.localDate,
        type: input.type,
        value: Math.round(input.value * 10) / 10,
        note: input.note ?? null,
      },
      sanitizeClientTime(input.clientUpdatedAt, now),
      now,
    ); // fmt: skip
    return { applied, record: toMeasurement((await this.repo.get(userId, id))!) };
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

  async list(userId: string, from: string, to: string, type: MeasurementType | null) {
    assertRangeWithin(from, to, MAX_RANGE_DAYS);
    return { items: (await this.repo.list(userId, from, to, type)).map(toMeasurement) };
  }
}
