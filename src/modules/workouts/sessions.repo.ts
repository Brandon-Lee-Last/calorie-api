import { all } from '../../db/sql';
import { SyncedTable, type DeleteResult, type UpsertResult } from '../../db/synced-table';

export type SessionRow = {
  id: string;
  user_id: string;
  workout_id: string | null;
  program_id: string | null;
  title: string;
  started_at: number;
  finished_at: number | null;
  local_date: string;
  sets: string;
  notes: string | null;
  rating: number | null;
  calories_burned: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  client_updated_at: number;
  rev: number;
}; // fmt: skip

export type SessionData = {
  workoutId: string | null;
  programId: string | null;
  title: string;
  startedAt: number;
  finishedAt: number | null;
  localDate: string;
  sets: string;
  notes: string | null;
  rating: number | null;
  caloriesBurned: number | null;
}; // fmt: skip

export const sessionsTable = new SyncedTable('workout_sessions', [
  'workout_id',
  'program_id',
  'title',
  'started_at',
  'finished_at',
  'local_date',
  'sets',
  'notes',
  'rating',
  'calories_burned',
]); // fmt: skip

export class SessionsRepo {
  constructor(private db: D1Database) {}

  upsert(
    userId: string,
    id: string,
    d: SessionData,
    clientUpdatedAt: number,
    now: number,
  ): Promise<UpsertResult> {
    return sessionsTable.upsert(
      this.db,
      userId,
      id,
      {
        workout_id: d.workoutId,
        program_id: d.programId,
        title: d.title,
        started_at: d.startedAt,
        finished_at: d.finishedAt,
        local_date: d.localDate,
        sets: d.sets,
        notes: d.notes,
        rating: d.rating,
        calories_burned: d.caloriesBurned,
      },
      clientUpdatedAt,
      now,
    ); // fmt: skip
  }
  delete(
    userId: string,
    id: string,
    clientUpdatedAt: number,
    now: number,
    force = false,
  ): Promise<DeleteResult> {
    return sessionsTable.softDelete(this.db, userId, id, clientUpdatedAt, now, force);
  }
  get(userId: string, id: string) {
    return sessionsTable.get<SessionRow>(this.db, userId, id);
  }
  taken(userId: string, id: string) {
    return sessionsTable.takenByAnother(this.db, userId, id);
  }
  list(userId: string, from: string, to: string): Promise<SessionRow[]> {
    return all<SessionRow>(
      this.db
        .prepare(
          'SELECT * FROM workout_sessions WHERE user_id = ? AND local_date BETWEEN ? AND ? AND deleted_at IS NULL ORDER BY started_at, id',
        )
        .bind(userId, from, to),
    );
  }
}
