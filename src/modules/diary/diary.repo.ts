import { all, first } from '../../db/sql';
import { SyncedTable, type DeleteResult, type UpsertResult } from '../../db/synced-table';
import type { MealType } from './diary.types';

export type EntryRow = {
  id: string;
  user_id: string;
  logged_at: number;
  local_date: string;
  meal_type: MealType;
  name: string;
  food_id: string | null;
  quantity_g: number | null;
  servings: number | null;
  calories: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fiber_g: number | null;
  sugar_g: number | null;
  sodium_mg: number | null;
  source: string;
  scan_id: string | null;
  photo_key: string | null;
  note: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  client_updated_at: number;
  rev: number;
}; // fmt: skip

export type EntryData = {
  loggedAt: number;
  localDate: string;
  mealType: MealType;
  name: string;
  foodId: string | null;
  quantityG: number | null;
  servings: number | null;
  calories: number;
  proteinG: number;
  carbG: number;
  fatG: number;
  fiberG: number | null;
  sugarG: number | null;
  sodiumMg: number | null;
  source: string;
  scanId: string | null;
  note: string | null;
}; // fmt: skip

export type DayRow = {
  local_date: string;
  entries: number;
  calories: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fiber_g: number;
  sugar_g: number;
  sodium_mg: number;
}; // fmt: skip

export type RecentRow = {
  name: string;
  meal_type: MealType;
  calories: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  quantity_g: number | null;
  servings: number | null;
  food_id: string | null;
  last_logged_at: number;
  times: number;
}; // fmt: skip

export const entriesTable = new SyncedTable('diary_entries', [
  'logged_at',
  'local_date',
  'meal_type',
  'name',
  'food_id',
  'quantity_g',
  'servings',
  'calories',
  'protein_g',
  'carb_g',
  'fat_g',
  'fiber_g',
  'sugar_g',
  'sodium_mg',
  'source',
  'scan_id',
  'note',
]); // fmt: skip

export class DiaryRepo {
  constructor(private db: D1Database) {}

  upsert(
    userId: string,
    id: string,
    d: EntryData,
    clientUpdatedAt: number,
    now: number,
  ): Promise<UpsertResult> {
    return entriesTable.upsert(
      this.db,
      userId,
      id,
      {
        logged_at: d.loggedAt,
        local_date: d.localDate,
        meal_type: d.mealType,
        name: d.name,
        food_id: d.foodId,
        quantity_g: d.quantityG,
        servings: d.servings,
        calories: d.calories,
        protein_g: d.proteinG,
        carb_g: d.carbG,
        fat_g: d.fatG,
        fiber_g: d.fiberG,
        sugar_g: d.sugarG,
        sodium_mg: d.sodiumMg,
        source: d.source,
        scan_id: d.scanId,
        note: d.note,
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
    return entriesTable.softDelete(this.db, userId, id, clientUpdatedAt, now, force);
  }

  get(userId: string, id: string) {
    return entriesTable.get<EntryRow>(this.db, userId, id);
  }

  taken(userId: string, id: string) {
    return entriesTable.takenByAnother(this.db, userId, id);
  }

  list(userId: string, from: string, to: string): Promise<EntryRow[]> {
    return all<EntryRow>(
      this.db
        .prepare(
          'SELECT * FROM diary_entries WHERE user_id = ? AND local_date BETWEEN ? AND ? AND deleted_at IS NULL ORDER BY local_date, logged_at, id',
        )
        .bind(userId, from, to),
    );
  }

  daySummary(userId: string, from: string, to: string): Promise<DayRow[]> {
    return all<DayRow>(
      this.db
        .prepare(
          `SELECT local_date, COUNT(*) AS entries, SUM(calories) AS calories, SUM(protein_g) AS protein_g, SUM(carb_g) AS carb_g,
                  SUM(fat_g) AS fat_g, COALESCE(SUM(fiber_g), 0) AS fiber_g, COALESCE(SUM(sugar_g), 0) AS sugar_g,
                  COALESCE(SUM(sodium_mg), 0) AS sodium_mg
           FROM diary_entries WHERE user_id = ? AND local_date BETWEEN ? AND ? AND deleted_at IS NULL
           GROUP BY local_date ORDER BY local_date`,
        )
        .bind(userId, from, to),
    );
  }

  waterByDay(userId: string, from: string, to: string): Promise<{ local_date: string; ml: number }[]> {
    return all(
      this.db
        .prepare(
          'SELECT local_date, SUM(ml) AS ml FROM water_logs WHERE user_id = ? AND local_date BETWEEN ? AND ? AND deleted_at IS NULL GROUP BY local_date',
        )
        .bind(userId, from, to),
    );
  }

  /** The most recent entry of each distinct food name, newest first, with how often it was logged. */
  recent(userId: string, sinceMs: number, limit: number): Promise<RecentRow[]> {
    return all<RecentRow>(
      this.db
        .prepare(
          `SELECT e.name, e.meal_type, e.calories, e.protein_g, e.carb_g, e.fat_g, e.quantity_g, e.servings, e.food_id,
                  e.logged_at AS last_logged_at, g.times
           FROM diary_entries e
           JOIN (SELECT lower(name) AS lname, MAX(logged_at) AS latest, COUNT(*) AS times
                 FROM diary_entries WHERE user_id = ? AND deleted_at IS NULL AND logged_at >= ? GROUP BY lower(name)) g
             ON lower(e.name) = g.lname AND e.logged_at = g.latest
           WHERE e.user_id = ? AND e.deleted_at IS NULL
           GROUP BY lower(e.name)
           ORDER BY e.logged_at DESC LIMIT ?`,
        )
        .bind(userId, sinceMs, userId, limit),
    );
  }

  async countPhotos(userId: string): Promise<number> {
    const row = await first<{ n: number }>(
      this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM diary_entries WHERE user_id = ? AND photo_key IS NOT NULL AND deleted_at IS NULL',
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
          `UPDATE diary_entries SET photo_key = ?, updated_at = ?, rev = (SELECT sync_rev FROM users WHERE id = ?)
           WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        )
        .bind(key, now, userId, id, userId),
    ]);
    return (res[1]!.meta.changes ?? 0) === 1;
  }
}
