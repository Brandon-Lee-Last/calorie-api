import { all, first } from '../../db/sql';

export type ContributionRow = {
  id: string;
  user_id: string;
  created_at: number;
  model_version: string;
  food_probability: number | null;
  pred_calories: number | null;
  outcome: 'saved' | 'edited' | 'discarded' | 'not_food';
  final_calories: number | null;
  final_mass_g: number | null;
  final_fat_g: number | null;
  final_carb_g: number | null;
  final_protein_g: number | null;
  portion: number | null;
  image_key: string;
};

export class TrainingRepo {
  constructor(private db: D1Database) {}

  /** Photos whose owner agreed, oldest first, after the given position. A person who took consent back has no image_key. */
  list(
    after: { createdAt: number; id: string } | null,
    since: number,
    limit: number,
  ): Promise<ContributionRow[]> {
    return all<ContributionRow>(
      this.db
        .prepare(
          `SELECT id, user_id, created_at, model_version, food_probability, pred_calories, outcome,
                  final_calories, final_mass_g, final_fat_g, final_carb_g, final_protein_g, portion, image_key
           FROM scan_events
           WHERE contribute_consent = 1 AND image_key IS NOT NULL AND created_at >= ?1
             AND (?2 IS NULL OR created_at > ?2 OR (created_at = ?2 AND id > ?3))
           ORDER BY created_at, id LIMIT ?4`,
        )
        .bind(since, after?.createdAt ?? null, after?.id ?? '', limit),
    );
  }

  get(id: string): Promise<ContributionRow | null> {
    return first<ContributionRow>(
      this.db
        .prepare(
          `SELECT id, user_id, created_at, model_version, food_probability, pred_calories, outcome,
                  final_calories, final_mass_g, final_fat_g, final_carb_g, final_protein_g, portion, image_key
           FROM scan_events WHERE id = ? AND contribute_consent = 1 AND image_key IS NOT NULL`,
        )
        .bind(id),
    );
  }
}
