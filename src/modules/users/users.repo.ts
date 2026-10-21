import { first, run } from '../../db/sql';
import type { ActivityLevel, GoalType, Sex } from '../../lib/nutrition';

export type ProfileRow = {
  user_id: string;
  updated_at: number;
  timezone: string;
  locale: string;
  units: 'metric' | 'imperial';
  sex: Sex | null;
  birth_year: number | null;
  height_cm: number | null;
  weight_kg: number | null;
  activity_level: ActivityLevel | null;
  goal: GoalType;
  goal_rate_kg_per_week: number;
  target_weight_kg: number | null;
  calorie_goal: number;
  protein_goal_g: number;
  carb_goal_g: number;
  fat_goal_g: number;
  goals_are_custom: number;
  onboarded_at: number | null;
};

export type ProfileUpdate = Partial<Omit<ProfileRow, 'user_id' | 'updated_at'>>;

const UPDATABLE = new Set([
  'timezone',
  'locale',
  'units',
  'sex',
  'birth_year',
  'height_cm',
  'weight_kg',
  'activity_level',
  'goal',
  'goal_rate_kg_per_week',
  'target_weight_kg',
  'calorie_goal',
  'protein_goal_g',
  'carb_goal_g',
  'fat_goal_g',
  'goals_are_custom',
  'onboarded_at',
]); // fmt: skip

export class UsersRepo {
  constructor(private db: D1Database) {}

  getProfile(userId: string): Promise<ProfileRow | null> {
    return first<ProfileRow>(this.db.prepare('SELECT * FROM user_profiles WHERE user_id = ?').bind(userId));
  }

  /** Column names come from a fixed allow-list, never from the request. */
  async updateProfile(userId: string, patch: ProfileUpdate, now: number): Promise<void> {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    for (const [k] of entries) if (!UPDATABLE.has(k)) throw new Error(`Unknown profile column ${k}`);
    const sets = [...entries.map(([k]) => `${k} = ?`), 'updated_at = ?'].join(', ');
    await run(
      this.db
        .prepare(`UPDATE user_profiles SET ${sets} WHERE user_id = ?`)
        .bind(...entries.map(([, v]) => v), now, userId),
    );
  }

  async updateUser(userId: string, displayName: string | null, now: number): Promise<void> {
    await run(
      this.db
        .prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?')
        .bind(displayName, now, userId),
    );
  }
}
