import { all, first } from '../../db/sql';
import { SyncedTable, type DeleteResult, type UpsertResult } from '../../db/synced-table';

export type ProgressRow = {
  id: string;
  user_id: string;
  logged_at: number;
  local_date: string;
  pose: string;
  weight_kg: number | null;
  note: string | null;
  photo_key: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  client_updated_at: number;
  rev: number;
}; // fmt: skip

export const progressTable = new SyncedTable('progress_photos', [
  'logged_at',
  'local_date',
  'pose',
  'weight_kg',
  'note',
]);

export class ProgressRepo {
  constructor(private db: D1Database) {}

  upsert(
    userId: string,
    id: string,
    d: { loggedAt: number; localDate: string; pose: string; weightKg: number | null; note: string | null },
    cu: number,
    now: number,
  ): Promise<UpsertResult> {
    return progressTable.upsert(
      this.db,
      userId,
      id,
      { logged_at: d.loggedAt, local_date: d.localDate, pose: d.pose, weight_kg: d.weightKg, note: d.note },
      cu,
      now,
    );
  }
  delete(userId: string, id: string, cu: number, now: number, force = false): Promise<DeleteResult> {
    return progressTable.softDelete(this.db, userId, id, cu, now, force);
  }
  get(userId: string, id: string) {
    return progressTable.get<ProgressRow>(this.db, userId, id);
  }
  taken(userId: string, id: string) {
    return progressTable.takenByAnother(this.db, userId, id);
  }
  list(userId: string, from: string, to: string): Promise<ProgressRow[]> {
    return all<ProgressRow>(
      this.db
        .prepare(
          'SELECT * FROM progress_photos WHERE user_id = ? AND local_date BETWEEN ? AND ? AND deleted_at IS NULL ORDER BY local_date, logged_at',
        )
        .bind(userId, from, to),
    );
  }
  async countPhotos(userId: string): Promise<number> {
    const row = await first<{ n: number }>(
      this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM progress_photos WHERE user_id = ? AND photo_key IS NOT NULL AND deleted_at IS NULL',
        )
        .bind(userId),
    );
    return row?.n ?? 0;
  }
  /** Attach or remove the photo key. Bumps the revision so other devices learn about it; the edit time is unchanged. */
  async setPhotoKey(userId: string, id: string, key: string | null, now: number): Promise<boolean> {
    const res = await this.db.batch([
      this.db.prepare('UPDATE users SET sync_rev = sync_rev + 1 WHERE id = ?').bind(userId),
      this.db
        .prepare(
          `UPDATE progress_photos SET photo_key = ?, updated_at = ?, rev = (SELECT sync_rev FROM users WHERE id = ?)
           WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        )
        .bind(key, now, userId, id, userId),
    ]);
    return (res[1]!.meta.changes ?? 0) === 1;
  }
}
