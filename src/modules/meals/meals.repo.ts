import { all, run } from '../../db/sql';
import type { Tier } from '../workouts/workouts.types';

export type DietRow = { slug: string; tier: Tier; position: number; body: string; updated_at: number };
export type MealRow = { slug: string; body: string; updated_at: number };

export class MealsRepo {
  constructor(private db: D1Database) {}

  diets(): Promise<DietRow[]> {
    return all(this.db.prepare('SELECT * FROM diets ORDER BY position, slug'));
  }

  meals(): Promise<MealRow[]> {
    return all(this.db.prepare('SELECT * FROM meals ORDER BY slug'));
  }

  putDiet(slug: string, tier: Tier, position: number, body: string, now: number): Promise<number> {
    return run(
      this.db
        .prepare(
          `INSERT INTO diets (slug, tier, position, body, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (slug) DO UPDATE SET tier = ?2, position = ?3, body = ?4, updated_at = ?5`,
        )
        .bind(slug, tier, position, body, now),
    );
  }

  putMeal(slug: string, body: string, now: number): Promise<number> {
    return run(
      this.db
        .prepare(
          `INSERT INTO meals (slug, body, updated_at) VALUES (?1, ?2, ?3)
           ON CONFLICT (slug) DO UPDATE SET body = ?2, updated_at = ?3`,
        )
        .bind(slug, body, now),
    );
  }

  deleteDiet(slug: string): Promise<number> {
    return run(this.db.prepare('DELETE FROM diets WHERE slug = ?1').bind(slug));
  }

  deleteMeal(slug: string): Promise<number> {
    return run(this.db.prepare('DELETE FROM meals WHERE slug = ?1').bind(slug));
  }
}
