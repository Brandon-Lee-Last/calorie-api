import { conflict, validationFailed } from '../../core/errors';
import { DAY, type Clock } from '../../core/time';
import { assertLoggedTime, assertRangeWithin, sanitizeClientTime } from '../../core/validation';
import type { SessionRow, SessionsRepo } from './sessions.repo';
import type { WorkoutsRepo } from './workouts.repo';

export const MAX_SESSION_RANGE_DAYS = 366;
const MAX_SESSION_LENGTH_MS = DAY;

type SetLog = {
  exercise: string;
  setNo: number;
  reps?: number | null;
  weightKg?: number | null;
  durationS?: number | null;
  distanceM?: number | null;
  rpe?: number | null;
}; // fmt: skip

export type SessionInput = {
  workoutId?: string | null;
  programId?: string | null;
  title: string;
  startedAt: number;
  finishedAt?: number | null;
  localDate: string;
  sets: SetLog[];
  notes?: string | null;
  rating?: number | null;
  caloriesBurned?: number | null;
  clientUpdatedAt: number;
}; // fmt: skip

const parseSets = (s: string): SetLog[] => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

export const toSession = (r: SessionRow) => ({
  id: r.id,
  workoutId: r.workout_id,
  programId: r.program_id,
  title: r.title,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  localDate: r.local_date,
  sets: parseSets(r.sets),
  notes: r.notes,
  rating: r.rating,
  caloriesBurned: r.calories_burned,
  clientUpdatedAt: r.client_updated_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
  rev: r.rev,
}); // fmt: skip

export class SessionsService {
  constructor(
    private repo: SessionsRepo,
    private workoutsRepo: WorkoutsRepo,
    private onProgramProgress: (userId: string, programId: string) => Promise<void>,
    private clock: Clock,
  ) {}

  async put(userId: string, id: string, input: SessionInput) {
    const now = this.clock.now();
    assertLoggedTime({ loggedAt: input.startedAt, localDate: input.localDate }, now);
    if (input.finishedAt != null) {
      if (
        input.finishedAt < input.startedAt ||
        input.finishedAt - input.startedAt > MAX_SESSION_LENGTH_MS ||
        input.finishedAt > now + 5 * 60_000
      ) {
        throw validationFailed([
          {
            path: 'finishedAt',
            message: 'Must be after startedAt, within a day of it, and not in the future',
          },
        ]);
      }
    }
    if (input.workoutId && input.programId) {
      const w = await this.workoutsRepo.getWorkout(input.workoutId);
      if (w && w.program_id !== input.programId) {
        throw validationFailed([
          { path: 'workoutId', message: 'That workout is not part of the given program' },
        ]);
      }
    }
    if (await this.repo.taken(userId, id)) throw conflict('That id is already in use');
    const { applied } = await this.repo.upsert(
      userId,
      id,
      {
        workoutId: input.workoutId ?? null,
        programId: input.programId ?? null,
        title: input.title,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt ?? null,
        localDate: input.localDate,
        sets: JSON.stringify(input.sets),
        notes: input.notes ?? null,
        rating: input.rating ?? null,
        caloriesBurned: input.caloriesBurned ?? null,
      },
      sanitizeClientTime(input.clientUpdatedAt, now),
      now,
    ); // fmt: skip
    const record = (await this.repo.get(userId, id))!;
    if (applied && record.finished_at !== null && record.program_id)
      await this.onProgramProgress(userId, record.program_id);
    return { applied, record: toSession(record) };
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
    assertRangeWithin(from, to, MAX_SESSION_RANGE_DAYS);
    return { items: (await this.repo.list(userId, from, to)).map(toSession) };
  }

  async stats(userId: string, from: string, to: string) {
    assertRangeWithin(from, to, MAX_SESSION_RANGE_DAYS);
    const finished = (await this.repo.list(userId, from, to)).filter((r) => r.finished_at !== null);
    let minutes = 0;
    let sets = 0;
    let volume = 0;
    const byDate: Record<string, number> = {};
    for (const r of finished) {
      minutes += Math.round((r.finished_at! - r.started_at) / 60_000);
      byDate[r.local_date] = (byDate[r.local_date] ?? 0) + 1;
      for (const s of parseSets(r.sets)) {
        sets += 1;
        volume += (s.reps ?? 0) * (s.weightKg ?? 0);
      }
    }
    return { sessions: finished.length, minutes, sets, volumeKg: Math.round(volume * 10) / 10, byDate };
  }
}
