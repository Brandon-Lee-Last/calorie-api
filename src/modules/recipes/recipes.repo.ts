import { all, first } from '../../db/sql';
import { SyncedTable, type DeleteResult, type UpsertResult } from '../../db/synced-table';

export type RecipeRow = {
  id: string;
  user_id: string;
  name: string;
  servings: number;
  ingredients: string;
  instructions: string | null;
  prep_minutes: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  client_updated_at: number;
  rev: number;
}; // fmt: skip

export type RecipeData = {
  name: string;
  servings: number;
  ingredients: string;
  instructions: string | null;
  prepMinutes: number | null;
};

export const recipesTable = new SyncedTable('recipes', [
  'name',
  'servings',
  'ingredients',
  'instructions',
  'prep_minutes',
]);

export class RecipesRepo {
  constructor(private db: D1Database) {}

  upsert(userId: string, id: string, d: RecipeData, cu: number, now: number): Promise<UpsertResult> {
    return recipesTable.upsert(
      this.db,
      userId,
      id,
      {
        name: d.name,
        servings: d.servings,
        ingredients: d.ingredients,
        instructions: d.instructions,
        prep_minutes: d.prepMinutes,
      },
      cu,
      now,
    ); // fmt: skip
  }
  delete(userId: string, id: string, cu: number, now: number, force = false): Promise<DeleteResult> {
    return recipesTable.softDelete(this.db, userId, id, cu, now, force);
  }
  get(userId: string, id: string) {
    return recipesTable.get<RecipeRow>(this.db, userId, id);
  }
  taken(userId: string, id: string) {
    return recipesTable.takenByAnother(this.db, userId, id);
  }
  async count(userId: string): Promise<number> {
    const row = await first<{ n: number }>(
      this.db
        .prepare('SELECT COUNT(*) AS n FROM recipes WHERE user_id = ? AND deleted_at IS NULL')
        .bind(userId),
    );
    return row?.n ?? 0;
  }
  /** By name, then id, after the given position. */
  list(userId: string, after: { name: string; id: string } | null, limit: number): Promise<RecipeRow[]> {
    return all<RecipeRow>(
      this.db
        .prepare(
          `SELECT * FROM recipes WHERE user_id = ?1 AND deleted_at IS NULL
             AND (?2 IS NULL OR name > ?2 OR (name = ?2 AND id > ?3))
           ORDER BY name, id LIMIT ?4`,
        )
        .bind(userId, after?.name ?? null, after?.id ?? '', limit),
    );
  }
}
