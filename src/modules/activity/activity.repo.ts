import { all } from '../../db/sql';
import { SyncedTable, type DeleteResult, type UpsertResult } from '../../db/synced-table';

export type ActivityRow = {
  id: string;
  user_id: string;
  logged_at: number;
  local_date: string;
  kind: string;
  name: string | null;
  duration_min: number | null;
  steps: number | null;
  distance_km: number | null;
  calories_burned: number | null;
  calories_estimated: number;
  note: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  client_updated_at: number;
  rev: number;
}; // fmt: skip

export type ActivityData = {
  loggedAt: number;
  localDate: string;
  kind: string;
  name: string | null;
  durationMin: number | null;
  steps: number | null;
  distanceKm: number | null;
  caloriesBurned: number | null;
  caloriesEstimated: boolean;
  note: string | null;
}; // fmt: skip

export const activityTable = new SyncedTable('activity_logs', [
  'logged_at',
  'local_date',
  'kind',
  'name',
  'duration_min',
  'steps',
  'distance_km',
  'calories_burned',
  'calories_estimated',
  'note',
]); // fmt: skip

export class ActivityRepo {
  constructor(private db: D1Database) {}

  upsert(userId: string, id: string, d: ActivityData, cu: number, now: number): Promise<UpsertResult> {
    return activityTable.upsert(
      this.db,
      userId,
      id,
      {
        logged_at: d.loggedAt,
        local_date: d.localDate,
        kind: d.kind,
        name: d.name,
        duration_min: d.durationMin,
        steps: d.steps,
        distance_km: d.distanceKm,
        calories_burned: d.caloriesBurned,
        calories_estimated: d.caloriesEstimated ? 1 : 0,
        note: d.note,
      },
      cu,
      now,
    ); // fmt: skip
  }
  delete(userId: string, id: string, cu: number, now: number, force = false): Promise<DeleteResult> {
    return activityTable.softDelete(this.db, userId, id, cu, now, force);
  }
  get(userId: string, id: string) {
    return activityTable.get<ActivityRow>(this.db, userId, id);
  }
  taken(userId: string, id: string) {
    return activityTable.takenByAnother(this.db, userId, id);
  }
  list(userId: string, from: string, to: string): Promise<ActivityRow[]> {
    return all<ActivityRow>(
      this.db
        .prepare(
          'SELECT * FROM activity_logs WHERE user_id = ? AND local_date BETWEEN ? AND ? AND deleted_at IS NULL ORDER BY local_date, logged_at',
        )
        .bind(userId, from, to),
    );
  }
}
