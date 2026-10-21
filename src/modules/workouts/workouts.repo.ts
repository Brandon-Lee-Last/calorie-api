import { all, first, run } from '../../db/sql';
import { escapeLike } from '../../lib/text';
import type { Level, Goal, Tier } from './workouts.types';

export type ExerciseRow = {
  id: string;
  slug: string;
  name: string;
  name_norm: string;
  muscle_groups: string;
  equipment: string;
  difficulty: Level;
  instructions: string;
  tips: string | null;
  image_media_id: string | null;
  video_media_id: string | null;
  source: string | null;
  licence: string | null;
  created_at: number;
  updated_at: number;
}; // fmt: skip

export type ProgramRow = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  description: string;
  level: Level;
  goal: Goal;
  weeks: number;
  days_per_week: number;
  equipment: string;
  cover_media_id: string | null;
  tier: Tier;
  author: string | null;
  position: number;
  published_at: number | null;
  created_at: number;
  updated_at: number;
}; // fmt: skip

export type WorkoutRow = {
  id: string;
  program_id: string;
  key: string;
  week: number;
  day: number;
  position: number;
  title: string;
  notes: string | null;
  est_minutes: number | null;
  tier_override: Tier | null;
}; // fmt: skip

export type WorkoutExerciseRow = {
  id: string;
  workout_id: string;
  exercise_id: string;
  position: number;
  sets: number;
  reps_min: number | null;
  reps_max: number | null;
  duration_s: number | null;
  rest_s: number | null;
  notes: string | null;
}; // fmt: skip

export type EnrollmentRow = {
  id: string;
  user_id: string;
  program_id: string;
  status: 'active' | 'completed' | 'left';
  started_at: number;
  updated_at: number;
};

const LIVE = 'published_at IS NOT NULL';

export class WorkoutsRepo {
  constructor(private db: D1Database) {}

  // ---- exercises -----------------------------------------------------------------------------------------------

  async searchExercises(
    f: { tokens: string[]; muscle?: string; equipment?: string; difficulty?: string },
    after: { name: string; id: string } | null,
    limit: number,
  ): Promise<ExerciseRow[]> {
    const where: string[] = [];
    const binds: unknown[] = [];
    for (const t of f.tokens) {
      where.push(`name_norm LIKE ? ESCAPE '\\'`);
      binds.push(`%${escapeLike(t)}%`);
    }
    if (f.muscle) {
      where.push('muscle_groups LIKE ?');
      binds.push(`%"${f.muscle}"%`);
    } // fmt: skip
    if (f.equipment) {
      where.push('equipment LIKE ?');
      binds.push(`%"${f.equipment}"%`);
    } // fmt: skip
    if (f.difficulty) {
      where.push('difficulty = ?');
      binds.push(f.difficulty);
    } // fmt: skip
    if (after) {
      where.push('(name_norm > ? OR (name_norm = ? AND id > ?))');
      binds.push(after.name, after.name, after.id);
    } // fmt: skip
    return all<ExerciseRow>(
      this.db
        .prepare(
          `SELECT * FROM exercises ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name_norm, id LIMIT ?`,
        )
        .bind(...binds, limit),
    );
  }

  getExerciseBySlug(slug: string): Promise<ExerciseRow | null> {
    return first<ExerciseRow>(this.db.prepare('SELECT * FROM exercises WHERE slug = ?').bind(slug));
  }

  // ---- programs and workouts -----------------------------------------------------------------------------------

  listPrograms(f: {
    level?: string;
    goal?: string;
    tier?: string;
  }): Promise<(ProgramRow & { workout_count: number })[]> {
    const where = [LIVE];
    const binds: unknown[] = [];
    if (f.level) {
      where.push('level = ?');
      binds.push(f.level);
    } // fmt: skip
    if (f.goal) {
      where.push('goal = ?');
      binds.push(f.goal);
    } // fmt: skip
    if (f.tier) {
      where.push('tier = ?');
      binds.push(f.tier);
    } // fmt: skip
    return all(
      this.db
        .prepare(
          `SELECT p.*, (SELECT COUNT(*) FROM workouts w WHERE w.program_id = p.id) AS workout_count
           FROM programs p WHERE ${where.join(' AND ')} ORDER BY position, title`,
        )
        .bind(...binds),
    );
  }

  getPublishedProgramBySlug(slug: string): Promise<(ProgramRow & { workout_count: number }) | null> {
    return first(
      this.db
        .prepare(
          `SELECT p.*, (SELECT COUNT(*) FROM workouts w WHERE w.program_id = p.id) AS workout_count
           FROM programs p WHERE slug = ? AND ${LIVE}`,
        )
        .bind(slug),
    );
  }

  getPublishedProgramById(id: string): Promise<(ProgramRow & { workout_count: number }) | null> {
    return first(
      this.db
        .prepare(
          `SELECT p.*, (SELECT COUNT(*) FROM workouts w WHERE w.program_id = p.id) AS workout_count
           FROM programs p WHERE id = ? AND ${LIVE}`,
        )
        .bind(id),
    );
  }

  outline(programId: string): Promise<(WorkoutRow & { exercise_count: number })[]> {
    return all(
      this.db
        .prepare(
          `SELECT w.*, (SELECT COUNT(*) FROM workout_exercises x WHERE x.workout_id = w.id) AS exercise_count
           FROM workouts w WHERE program_id = ? ORDER BY week, day, position, key`,
        )
        .bind(programId),
    );
  }

  /** A workout together with its program, but only if the program is published. */
  getWorkout(
    id: string,
  ): Promise<(WorkoutRow & { program_slug: string; program_title: string; program_tier: Tier }) | null> {
    return first(
      this.db
        .prepare(
          `SELECT w.*, p.slug AS program_slug, p.title AS program_title, p.tier AS program_tier
           FROM workouts w JOIN programs p ON p.id = w.program_id WHERE w.id = ? AND p.${LIVE}`,
        )
        .bind(id),
    );
  }

  workoutExercises(workoutId: string): Promise<(WorkoutExerciseRow & { ex: string })[]> {
    return all(
      this.db
        .prepare(
          `SELECT x.*, e.slug AS ex FROM workout_exercises x JOIN exercises e ON e.id = x.exercise_id
           WHERE x.workout_id = ? ORDER BY x.position`,
        )
        .bind(workoutId),
    );
  }

  exercisesByIds(ids: string[]): Promise<ExerciseRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return all<ExerciseRow>(
      this.db.prepare(`SELECT * FROM exercises WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids),
    );
  }

  // ---- enrolment and progress ----------------------------------------------------------------------------------

  getActiveEnrollment(userId: string): Promise<EnrollmentRow | null> {
    return first<EnrollmentRow>(
      this.db
        .prepare("SELECT * FROM program_enrollments WHERE user_id = ? AND status = 'active'")
        .bind(userId),
    );
  }

  async enroll(userId: string, programId: string, id: string, now: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE program_enrollments SET status = 'left', updated_at = ? WHERE user_id = ? AND status = 'active' AND program_id != ?",
        )
        .bind(now, userId, programId),
      this.db
        .prepare(
          `INSERT INTO program_enrollments (id, user_id, program_id, status, started_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)
           ON CONFLICT (user_id, program_id) DO UPDATE SET
             started_at = CASE WHEN program_enrollments.status = 'active' THEN program_enrollments.started_at ELSE excluded.started_at END,
             status = 'active', updated_at = excluded.updated_at`,
        )
        .bind(id, userId, programId, now, now),
    ]);
  }

  async leave(userId: string, programId: string, now: number): Promise<void> {
    await run(
      this.db
        .prepare(
          "UPDATE program_enrollments SET status = 'left', updated_at = ? WHERE user_id = ? AND program_id = ? AND status = 'active'",
        )
        .bind(now, userId, programId),
    );
  }

  async markCompleted(userId: string, programId: string, now: number): Promise<void> {
    await run(
      this.db
        .prepare(
          "UPDATE program_enrollments SET status = 'completed', updated_at = ? WHERE user_id = ? AND program_id = ? AND status = 'active'",
        )
        .bind(now, userId, programId),
    );
  }

  /** The workouts of a program this person has finished at least once. */
  async completedWorkoutIds(userId: string, programId: string): Promise<Set<string>> {
    const rows = await all<{ workout_id: string }>(
      this.db
        .prepare(
          `SELECT DISTINCT workout_id FROM workout_sessions
           WHERE user_id = ? AND program_id = ? AND workout_id IS NOT NULL AND finished_at IS NOT NULL AND deleted_at IS NULL`,
        )
        .bind(userId, programId),
    );
    return new Set(rows.map((r) => r.workout_id));
  }
}
