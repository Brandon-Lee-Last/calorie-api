import { all, run } from '../../db/sql';
import { placeholders } from '../../db/sql';
import type { CatalogueFood } from './catalogue.schemas';

export type CatalogueKey = { id: string; source: string; external_id: string; barcode: string | null };

/** Everything here touches only catalogue rows (`user_id IS NULL`), never anyone's own foods. */
export class CatalogueRepo {
  constructor(private db: D1Database) {}

  byExternalIds(externalIds: string[]): Promise<CatalogueKey[]> {
    if (externalIds.length === 0) return Promise.resolve([]);
    return all<CatalogueKey>(
      this.db
        .prepare(
          `SELECT id, source, external_id, barcode FROM foods WHERE user_id IS NULL AND external_id IN (${placeholders(externalIds.length)})`,
        )
        .bind(...externalIds),
    );
  }

  byBarcodes(barcodes: string[]): Promise<CatalogueKey[]> {
    if (barcodes.length === 0) return Promise.resolve([]);
    return all<CatalogueKey>(
      this.db
        .prepare(
          `SELECT id, source, external_id, barcode FROM foods WHERE user_id IS NULL AND barcode IN (${placeholders(barcodes.length)})`,
        )
        .bind(...barcodes),
    );
  }

  insert(id: string, f: Normalised, now: number): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO foods (id, user_id, source, external_id, barcode, name, name_norm, brand, serving_g, serving_label,
           calories_100g, protein_100g, carb_100g, fat_100g, fiber_100g, sugar_100g, sodium_mg_100g, dish_id, aliases_norm, created_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        f.source,
        f.externalId,
        f.barcode,
        f.name,
        f.nameNorm,
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
        f.dishId,
        f.aliasesNorm,
        now,
        now,
      ); // fmt: skip
  }

  update(id: string, f: Normalised, now: number): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE foods SET barcode = ?, name = ?, name_norm = ?, brand = ?, serving_g = ?, serving_label = ?,
           calories_100g = ?, protein_100g = ?, carb_100g = ?, fat_100g = ?, fiber_100g = ?, sugar_100g = ?, sodium_mg_100g = ?,
           dish_id = ?, aliases_norm = ?, updated_at = ?, deleted_at = NULL
         WHERE id = ? AND user_id IS NULL`,
      )
      .bind(
        f.barcode,
        f.name,
        f.nameNorm,
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
        f.dishId,
        f.aliasesNorm,
        now,
        id,
      ); // fmt: skip
  }

  async batch(stmts: D1PreparedStatement[]): Promise<void> {
    if (stmts.length > 0) await this.db.batch(stmts);
  }

  /** Remove a catalogue food. Diary entries that used it keep their own copy of the numbers, so nothing breaks. */
  async retire(id: string): Promise<boolean> {
    return (await run(this.db.prepare('DELETE FROM foods WHERE id = ? AND user_id IS NULL').bind(id))) === 1;
  }
}

export type Normalised = {
  source: CatalogueFood['source'];
  externalId: string;
  barcode: string | null;
  name: string;
  nameNorm: string;
  brand: string | null;
  servingG: number | null;
  servingLabel: string | null;
  calories100g: number;
  protein100g: number;
  carb100g: number;
  fat100g: number;
  fiber100g: number | null;
  sugar100g: number | null;
  sodiumMg100g: number | null;
  dishId: string | null;
  aliasesNorm: string | null;
};
