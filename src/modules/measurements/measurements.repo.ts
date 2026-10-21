import { all } from '../../db/sql';
import { SyncedTable, type DeleteResult, type UpsertResult } from '../../db/synced-table';

export type MeasurementRow = {
  id: string;
  user_id: string;
  logged_at: number;
  local_date: string;
  type: string;
  value: number;
  note: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  client_updated_at: number;
  rev: number;
}; // fmt: skip

export const measurementsTable = new SyncedTable('body_measurements', [
  'logged_at',
  'local_date',
  'type',
  'value',
  'note',
]);

export class MeasurementsRepo {
  constructor(private db: D1Database) {}

  upsert(
    userId: string,
    id: string,
    d: { loggedAt: number; localDate: string; type: string; value: number; note: string | null },
    cu: number,
    now: number,
  ): Promise<UpsertResult> {
    return measurementsTable.upsert(
      this.db,
      userId,
      id,
      { logged_at: d.loggedAt, local_date: d.localDate, type: d.type, value: d.value, note: d.note },
      cu,
      now,
    );
  }
  delete(userId: string, id: string, cu: number, now: number, force = false): Promise<DeleteResult> {
    return measurementsTable.softDelete(this.db, userId, id, cu, now, force);
  }
  get(userId: string, id: string) {
    return measurementsTable.get<MeasurementRow>(this.db, userId, id);
  }
  taken(userId: string, id: string) {
    return measurementsTable.takenByAnother(this.db, userId, id);
  }
  list(userId: string, from: string, to: string, type: string | null): Promise<MeasurementRow[]> {
    return all<MeasurementRow>(
      this.db
        .prepare(
          `SELECT * FROM body_measurements
           WHERE user_id = ? AND local_date BETWEEN ? AND ? AND deleted_at IS NULL AND (?4 IS NULL OR type = ?4)
           ORDER BY local_date, logged_at`,
        )
        .bind(userId, from, to, type),
    );
  }
}
