import { all, first, run } from '../../db/sql';
import { SyncedTable, type DeleteResult, type UpsertResult } from '../../db/synced-table';
import { escapeLike } from '../../lib/text';
import type { ExternalFood } from './off';

export type FoodRow = {
  id: string;
  user_id: string | null;
  source: 'custom' | 'openfoodfacts' | 'usda' | 'curated';
  external_id: string | null;
  barcode: string | null;
  name: string;
  name_norm: string;
  brand: string | null;
  serving_g: number | null;
  serving_label: string | null;
  calories_100g: number;
  protein_100g: number;
  carb_100g: number;
  fat_100g: number;
  fiber_100g: number | null;
  sugar_100g: number | null;
  sodium_mg_100g: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  client_updated_at: number;
  rev: number;
}; // fmt: skip

export type FoodData = {
  name: string;
  nameNorm: string;
  brand: string | null;
  barcode: string | null;
  servingG: number | null;
  servingLabel: string | null;
  calories100g: number;
  protein100g: number;
  carb100g: number;
  fat100g: number;
  fiber100g: number | null;
  sugar100g: number | null;
  sodiumMg100g: number | null;
}; // fmt: skip

export const foodsTable = new SyncedTable('foods', [
  'source',
  'name',
  'name_norm',
  'brand',
  'barcode',
  'serving_g',
  'serving_label',
  'calories_100g',
  'protein_100g',
  'carb_100g',
  'fat_100g',
  'fiber_100g',
  'sugar_100g',
  'sodium_mg_100g',
]); // fmt: skip

export class FoodsRepo {
  constructor(private db: D1Database) {}

  upsertCustom(
    userId: string,
    id: string,
    d: FoodData,
    clientUpdatedAt: number,
    now: number,
  ): Promise<UpsertResult> {
    return foodsTable.upsert(
      this.db,
      userId,
      id,
      {
        source: 'custom',
        name: d.name,
        name_norm: d.nameNorm,
        brand: d.brand,
        barcode: d.barcode,
        serving_g: d.servingG,
        serving_label: d.servingLabel,
        calories_100g: d.calories100g,
        protein_100g: d.protein100g,
        carb_100g: d.carb100g,
        fat_100g: d.fat100g,
        fiber_100g: d.fiber100g,
        sugar_100g: d.sugar100g,
        sodium_mg_100g: d.sodiumMg100g,
      },
      clientUpdatedAt,
      now,
    ); // fmt: skip
  }

  deleteCustom(
    userId: string,
    id: string,
    clientUpdatedAt: number,
    now: number,
    force = false,
  ): Promise<DeleteResult> {
    return foodsTable.softDelete(this.db, userId, id, clientUpdatedAt, now, force);
  }

  getOwn(userId: string, id: string) {
    return foodsTable.get<FoodRow>(this.db, userId, id);
  }

  takenByAnother(userId: string, id: string) {
    return foodsTable.takenByAnother(this.db, userId, id);
  }

  /** A catalogue food by id (visible to everyone) — only rows that belong to nobody. */
  getCatalogue(id: string): Promise<FoodRow | null> {
    return first<FoodRow>(
      this.db.prepare('SELECT * FROM foods WHERE id = ? AND user_id IS NULL AND deleted_at IS NULL').bind(id),
    );
  }

  findOwnByBarcode(userId: string, barcode: string): Promise<FoodRow | null> {
    return first<FoodRow>(
      this.db
        .prepare('SELECT * FROM foods WHERE user_id = ? AND barcode = ? AND deleted_at IS NULL')
        .bind(userId, barcode),
    );
  }

  findCatalogueByBarcode(barcode: string): Promise<FoodRow | null> {
    return first<FoodRow>(
      this.db
        .prepare('SELECT * FROM foods WHERE user_id IS NULL AND barcode = ? AND deleted_at IS NULL')
        .bind(barcode),
    );
  }

  /** Cache an external food in the shared catalogue. Two requests racing to cache the same product both succeed. */
  async cacheExternal(id: string, f: ExternalFood, nameNorm: string, now: number): Promise<void> {
    await run(
      this.db
        .prepare(
          `INSERT OR IGNORE INTO foods (id, user_id, source, external_id, barcode, name, name_norm, brand, serving_g, serving_label,
             calories_100g, protein_100g, carb_100g, fat_100g, fiber_100g, sugar_100g, sodium_mg_100g, created_at, updated_at)
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          f.source,
          f.externalId,
          f.barcode,
          f.name,
          nameNorm,
          f.brand,
          f.servingG,
          f.servingLabel,
          f.calories100g,
          f.protein100g,
          f.carb100g,
          f.fat100g,
          f.fiber100g,
          f.sugar100g,
          f.sodiumMg100g,
          now,
          now,
        ),
    ); // fmt: skip
  }

  /** Every token must appear in the name (or brand) somewhere. Own foods first. */
  search(userId: string, tokens: string[], limit: number): Promise<FoodRow[]> {
    const conds = tokens
      .map(() => `(name_norm LIKE ? ESCAPE '\\' OR lower(COALESCE(brand, '')) LIKE ? ESCAPE '\\')`)
      .join(' AND ');
    const binds = tokens.flatMap((t) => [`%${escapeLike(t)}%`, `%${escapeLike(t)}%`]);
    const first = tokens[0] ?? '';
    return all<FoodRow>(
      this.db
        .prepare(
          `SELECT * FROM foods
           WHERE deleted_at IS NULL AND (user_id = ? OR user_id IS NULL) AND ${conds}
           ORDER BY (user_id IS NULL), (name_norm LIKE ? ESCAPE '\\') DESC, length(name_norm), name_norm
           LIMIT ?`,
        )
        .bind(userId, ...binds, `${escapeLike(first)}%`, limit),
    );
  }
}
