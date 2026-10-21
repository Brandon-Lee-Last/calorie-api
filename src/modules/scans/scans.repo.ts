import { first, run } from '../../db/sql';

export type ScanRow = {
  id: string;
  user_id: string;
  created_at: number;
  client_created_at: number;
  model_version: string;
  food_probability: number | null;
  pred_calories: number | null;
  pred_mass_g: number | null;
  pred_fat_g: number | null;
  pred_carb_g: number | null;
  pred_protein_g: number | null;
  outcome: 'saved' | 'edited' | 'discarded' | 'not_food';
  final_calories: number | null;
  final_mass_g: number | null;
  final_fat_g: number | null;
  final_carb_g: number | null;
  final_protein_g: number | null;
  portion: number | null;
  contribute_consent: number;
  image_key: string | null;
}; // fmt: skip

type Nutrition = { calories: number; massG: number; fatG: number; carbG: number; proteinG: number } | null;
export type ScanData = {
  modelVersion: string;
  foodProbability: number | null;
  predicted: Nutrition;
  outcome: ScanRow['outcome'];
  final: Nutrition;
  portion: number | null;
  contributeConsent: boolean;
  clientCreatedAt: number;
}; // fmt: skip

export class ScansRepo {
  constructor(private db: D1Database) {}

  get(userId: string, id: string): Promise<ScanRow | null> {
    return first<ScanRow>(
      this.db.prepare('SELECT * FROM scan_events WHERE id = ? AND user_id = ?').bind(id, userId),
    );
  }

  async idTakenByAnother(userId: string, id: string): Promise<boolean> {
    const row = await first<{ user_id: string }>(
      this.db.prepare('SELECT user_id FROM scan_events WHERE id = ?').bind(id),
    );
    return row !== null && row.user_id !== userId;
  }

  /** New events are inserted; a repeat from the same user updates the outcome (a scan can be saved, then edited). */
  async upsert(userId: string, id: string, d: ScanData, now: number): Promise<void> {
    const p = d.predicted;
    const f = d.final;
    await run(
      this.db
        .prepare(
          `INSERT INTO scan_events (id, user_id, created_at, client_created_at, model_version, food_probability,
             pred_calories, pred_mass_g, pred_fat_g, pred_carb_g, pred_protein_g, outcome,
             final_calories, final_mass_g, final_fat_g, final_carb_g, final_protein_g, portion, contribute_consent)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET outcome = excluded.outcome, final_calories = excluded.final_calories,
             final_mass_g = excluded.final_mass_g, final_fat_g = excluded.final_fat_g, final_carb_g = excluded.final_carb_g,
             final_protein_g = excluded.final_protein_g, portion = excluded.portion, contribute_consent = excluded.contribute_consent
           WHERE scan_events.user_id = excluded.user_id`,
        )
        .bind(
          id,
          userId,
          now,
          d.clientCreatedAt,
          d.modelVersion,
          d.foodProbability,
          p?.calories ?? null,
          p?.massG ?? null,
          p?.fatG ?? null,
          p?.carbG ?? null,
          p?.proteinG ?? null,
          d.outcome,
          f?.calories ?? null,
          f?.massG ?? null,
          f?.fatG ?? null,
          f?.carbG ?? null,
          f?.proteinG ?? null,
          d.portion,
          d.contributeConsent ? 1 : 0,
        ), // fmt: skip
    );
  }

  async setImageKey(userId: string, id: string, key: string | null): Promise<void> {
    await run(
      this.db
        .prepare('UPDATE scan_events SET image_key = ? WHERE id = ? AND user_id = ?')
        .bind(key, id, userId),
    );
  }
}
