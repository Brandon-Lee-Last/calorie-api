import { all, chunk, first, run } from '../../db/sql';

export type ProgramWriteWorkout = {
  id: string;
  key: string;
  week: number;
  day: number;
  position: number;
  title: string;
  notes: string | null;
  estMinutes: number | null;
  tierOverride: string | null;
  exercises: {
    exerciseId: string;
    sets: number;
    repsMin: number | null;
    repsMax: number | null;
    durationS: number | null;
    restS: number | null;
    notes: string | null;
  }[];
}; // fmt: skip

export type ProgramWrite = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  description: string;
  level: string;
  goal: string;
  weeks: number;
  daysPerWeek: number;
  equipment: string;
  coverMediaId: string | null;
  tier: string;
  author: string | null;
  position: number;
  workouts: ProgramWriteWorkout[];
}; // fmt: skip

export type ExerciseWrite = {
  id: string;
  slug: string;
  name: string;
  nameNorm: string;
  muscleGroups: string;
  equipment: string;
  difficulty: string;
  instructions: string;
  tips: string | null;
  imageMediaId: string | null;
  videoMediaId: string | null;
  source: string | null;
  licence: string | null;
}; // fmt: skip

export type AccuracyRow = {
  model_version: string;
  scans: number;
  not_food: number;
  discarded: number;
  kept: number;
  edited: number;
  mean_abs_kcal: number | null;
  mean_signed_kcal: number | null;
  photos: number;
}; // fmt: skip

export class AdminRepo {
  constructor(private db: D1Database) {}

  async upsertExercise(e: ExerciseWrite, now: number): Promise<void> {
    await run(
      this.db
        .prepare(
          `INSERT INTO exercises (id, slug, name, name_norm, muscle_groups, equipment, difficulty, instructions, tips, image_media_id,
             video_media_id, source, licence, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (slug) DO UPDATE SET name = excluded.name, name_norm = excluded.name_norm, muscle_groups = excluded.muscle_groups,
             equipment = excluded.equipment, difficulty = excluded.difficulty, instructions = excluded.instructions, tips = excluded.tips,
             image_media_id = excluded.image_media_id, video_media_id = excluded.video_media_id, source = excluded.source,
             licence = excluded.licence, updated_at = excluded.updated_at`,
        )
        .bind(
          e.id,
          e.slug,
          e.name,
          e.nameNorm,
          e.muscleGroups,
          e.equipment,
          e.difficulty,
          e.instructions,
          e.tips,
          e.imageMediaId,
          e.videoMediaId,
          e.source,
          e.licence,
          now,
          now,
        ),
    ); // fmt: skip
  }

  deleteExercise(slug: string): Promise<number> {
    return run(this.db.prepare('DELETE FROM exercises WHERE slug = ?').bind(slug));
  }

  async exerciseIdsBySlug(slugs: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const part of chunk([...new Set(slugs)], 90)) {
      const rows = await all<{ id: string; slug: string }>(
        this.db
          .prepare(`SELECT id, slug FROM exercises WHERE slug IN (${part.map(() => '?').join(',')})`)
          .bind(...part),
      );
      for (const r of rows) out.set(r.slug, r.id);
    }
    return out;
  }

  getExerciseId(slug: string): Promise<{ id: string } | null> {
    return first(this.db.prepare('SELECT id FROM exercises WHERE slug = ?').bind(slug));
  }

  getProgramBySlug(slug: string): Promise<{ id: string; published_at: number | null } | null> {
    return first(this.db.prepare('SELECT id, published_at FROM programs WHERE slug = ?').bind(slug));
  }

  existingWorkoutIds(programId: string): Promise<{ id: string; key: string }[]> {
    return all(this.db.prepare('SELECT id, key FROM workouts WHERE program_id = ?').bind(programId));
  }

  /**
   * Replace a program and everything in it in one atomic batch. Workouts are matched by `key`, so ids that people's history
   * points at survive a re-import. Multi-row inserts keep each statement under D1's 100 bound-parameter limit.
   */
  async writeProgram(p: ProgramWrite, existing: { id: string; key: string }[], now: number): Promise<void> {
    const db = this.db;
    const stmts: D1PreparedStatement[] = [
      db
        .prepare(
          `INSERT INTO programs (id, slug, title, summary, description, level, goal, weeks, days_per_week, equipment, cover_media_id,
             tier, author, position, published_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
           ON CONFLICT (slug) DO UPDATE SET title = excluded.title, summary = excluded.summary, description = excluded.description,
             level = excluded.level, goal = excluded.goal, weeks = excluded.weeks, days_per_week = excluded.days_per_week,
             equipment = excluded.equipment, cover_media_id = excluded.cover_media_id, tier = excluded.tier, author = excluded.author,
             position = excluded.position, updated_at = excluded.updated_at`,
        )
        .bind(
          p.id,
          p.slug,
          p.title,
          p.summary,
          p.description,
          p.level,
          p.goal,
          p.weeks,
          p.daysPerWeek,
          p.equipment,
          p.coverMediaId,
          p.tier,
          p.author,
          p.position,
          now,
          now,
        ),
    ]; // fmt: skip

    const keep = new Set(p.workouts.map((w) => w.key));
    const removed = existing.filter((e) => !keep.has(e.key)).map((e) => e.id);
    for (const part of chunk(removed, 90)) {
      stmts.push(
        db.prepare(`DELETE FROM workouts WHERE id IN (${part.map(() => '?').join(',')})`).bind(...part),
      );
    }
    for (const part of chunk(p.workouts, 10)) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO workouts (id, program_id, key, week, day, position, title, notes, est_minutes, tier_override)
             VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
             ON CONFLICT (program_id, key) DO UPDATE SET week = excluded.week, day = excluded.day, position = excluded.position,
               title = excluded.title, notes = excluded.notes, est_minutes = excluded.est_minutes, tier_override = excluded.tier_override`,
          )
          .bind(
            ...part.flatMap((w) => [
              w.id,
              p.id,
              w.key,
              w.week,
              w.day,
              w.position,
              w.title,
              w.notes,
              w.estMinutes,
              w.tierOverride,
            ]),
          ),
      );
    }
    stmts.push(
      db
        .prepare(
          'DELETE FROM workout_exercises WHERE workout_id IN (SELECT id FROM workouts WHERE program_id = ?)',
        )
        .bind(p.id),
    );
    const rows = p.workouts.flatMap((w) => w.exercises.map((x, i) => ({ w, x, i })));
    for (const part of chunk(rows, 9)) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO workout_exercises (id, workout_id, exercise_id, position, sets, reps_min, reps_max, duration_s, rest_s, notes)
             VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
          )
          .bind(
            ...part.flatMap(({ w, x, i }) => [
              `${w.id}:${i}`,
              w.id,
              x.exerciseId,
              i,
              x.sets,
              x.repsMin,
              x.repsMax,
              x.durationS,
              x.restS,
              x.notes,
            ]),
          ),
      );
    }
    await db.batch(stmts);
  }

  async setPublished(slug: string, publishedAt: number | null, now: number): Promise<number> {
    return run(
      this.db
        .prepare('UPDATE programs SET published_at = ?, updated_at = ? WHERE slug = ?')
        .bind(publishedAt, now, slug),
    );
  }

  deleteProgram(slug: string): Promise<number> {
    return run(this.db.prepare('DELETE FROM programs WHERE slug = ?').bind(slug));
  }

  listPrograms(): Promise<
    {
      id: string;
      slug: string;
      title: string;
      tier: string;
      published_at: number | null;
      updated_at: number;
      workout_count: number;
    }[]
  > {
    return all(
      this.db.prepare(
        `SELECT p.id, p.slug, p.title, p.tier, p.published_at, p.updated_at,
                (SELECT COUNT(*) FROM workouts w WHERE w.program_id = p.id) AS workout_count
         FROM programs p ORDER BY position, title`,
      ),
    );
  }

  /** Programs where some workout has no exercises can't be published. */
  async emptyWorkouts(programId: string): Promise<number> {
    const row = await first<{ n: number }>(
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM workouts w WHERE w.program_id = ?
           AND NOT EXISTS (SELECT 1 FROM workout_exercises x WHERE x.workout_id = w.id)`,
        )
        .bind(programId),
    );
    return row?.n ?? 0;
  }

  accuracy(modelVersion: string | null): Promise<AccuracyRow[]> {
    return all<AccuracyRow>(
      this.db
        .prepare(
          `SELECT model_version,
                  COUNT(*) AS scans,
                  SUM(outcome = 'not_food') AS not_food,
                  SUM(outcome = 'discarded') AS discarded,
                  SUM(outcome IN ('saved', 'edited')) AS kept,
                  SUM(outcome = 'edited') AS edited,
                  AVG(CASE WHEN outcome IN ('saved', 'edited') AND pred_calories IS NOT NULL AND final_calories IS NOT NULL
                           THEN ABS(final_calories - pred_calories * COALESCE(portion, 1)) END) AS mean_abs_kcal,
                  AVG(CASE WHEN outcome IN ('saved', 'edited') AND pred_calories IS NOT NULL AND final_calories IS NOT NULL
                           THEN final_calories - pred_calories * COALESCE(portion, 1) END) AS mean_signed_kcal,
                  SUM(image_key IS NOT NULL) AS photos
           FROM scan_events WHERE (? IS NULL OR model_version = ?)
           GROUP BY model_version ORDER BY model_version`,
        )
        .bind(modelVersion, modelVersion),
    );
  }
}
