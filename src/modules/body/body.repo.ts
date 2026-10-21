import { all, first } from '../../db/sql';
import { SyncedTable, type DeleteResult, type UpsertResult } from '../../db/synced-table';

export type WeightRow = {
  id: string;
  user_id: string;
  logged_at: number;
  local_date: string;
  weight_kg: number;
  note: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  client_updated_at: number;
  rev: number;
}; // fmt: skip
export type WaterRow = {
  id: string;
  user_id: string;
  logged_at: number;
  local_date: string;
  ml: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  client_updated_at: number;
  rev: number;
}; // fmt: skip

export const weightTable = new SyncedTable('weight_logs', ['logged_at', 'local_date', 'weight_kg', 'note']);
export const waterTable = new SyncedTable('water_logs', ['logged_at', 'local_date', 'ml']);

export class BodyRepo {
  constructor(private db: D1Database) {}

  upsertWeight(
    userId: string,
    id: string,
    d: { loggedAt: number; localDate: string; weightKg: number; note: string | null },
    cu: number,
    now: number,
  ): Promise<UpsertResult> {
    return weightTable.upsert(
      this.db,
      userId,
      id,
      { logged_at: d.loggedAt, local_date: d.localDate, weight_kg: d.weightKg, note: d.note },
      cu,
      now,
    );
  }
  deleteWeight(userId: string, id: string, cu: number, now: number): Promise<DeleteResult> {
    return weightTable.softDelete(this.db, userId, id, cu, now);
  }
  getWeight(userId: string, id: string) {
    return weightTable.get<WeightRow>(this.db, userId, id);
  }
  takenWeight(userId: string, id: string) {
    return weightTable.takenByAnother(this.db, userId, id);
  }
  listWeight(userId: string, from: string, to: string): Promise<WeightRow[]> {
    return all<WeightRow>(
      this.db
        .prepare(
          'SELECT * FROM weight_logs WHERE user_id = ? AND local_date BETWEEN ? AND ? AND deleted_at IS NULL ORDER BY local_date, logged_at',
        )
        .bind(userId, from, to),
    );
  }
  latestWeight(userId: string): Promise<WeightRow | null> {
    return first<WeightRow>(
      this.db
        .prepare(
          'SELECT * FROM weight_logs WHERE user_id = ? AND deleted_at IS NULL ORDER BY local_date DESC, logged_at DESC LIMIT 1',
        )
        .bind(userId),
    );
  }

  upsertWater(
    userId: string,
    id: string,
    d: { loggedAt: number; localDate: string; ml: number },
    cu: number,
    now: number,
  ): Promise<UpsertResult> {
    return waterTable.upsert(
      this.db,
      userId,
      id,
      { logged_at: d.loggedAt, local_date: d.localDate, ml: d.ml },
      cu,
      now,
    );
  }
  deleteWater(userId: string, id: string, cu: number, now: number): Promise<DeleteResult> {
    return waterTable.softDelete(this.db, userId, id, cu, now);
  }
  getWater(userId: string, id: string) {
    return waterTable.get<WaterRow>(this.db, userId, id);
  }
  takenWater(userId: string, id: string) {
    return waterTable.takenByAnother(this.db, userId, id);
  }
  listWater(userId: string, from: string, to: string): Promise<WaterRow[]> {
    return all<WaterRow>(
      this.db
        .prepare(
          'SELECT * FROM water_logs WHERE user_id = ? AND local_date BETWEEN ? AND ? AND deleted_at IS NULL ORDER BY logged_at',
        )
        .bind(userId, from, to),
    );
  }
}
