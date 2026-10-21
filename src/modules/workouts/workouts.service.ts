import { badRequest, notFound, subscriptionRequired } from '../../core/errors';
import { newId } from '../../core/ids';
import type { Clock } from '../../core/time';
import { decodeCursor, encodeCursor } from '../../core/pagination';
import { normalizeName } from '../../lib/text';
import type {
  EnrollmentRow,
  ExerciseRow,
  ProgramRow,
  WorkoutExerciseRow,
  WorkoutRow,
  WorkoutsRepo,
} from './workouts.repo';
import { EQUIPMENT, MUSCLES, type Tier } from './workouts.types';

type Plan = 'free' | 'pro';
const locked = (tier: Tier, plan: Plan) => tier === 'pro' && plan !== 'pro';
/** A JSON array stored as text, keeping only values we know about (so a bad row cannot break a response). */
function parseList<T extends string>(text: string, allowed: readonly T[]): T[] {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is T => allowed.includes(x)) : [];
  } catch {
    return [];
  }
}

export const toExercise = (r: ExerciseRow) => ({
  slug: r.slug,
  name: r.name,
  muscleGroups: parseList(r.muscle_groups, MUSCLES),
  equipment: parseList(r.equipment, EQUIPMENT),
  difficulty: r.difficulty,
  instructions: r.instructions,
  tips: r.tips,
  imageMediaId: r.image_media_id,
  videoMediaId: r.video_media_id,
  source: r.source,
  licence: r.licence,
}); // fmt: skip

export const toProgramSummary = (r: ProgramRow & { workout_count: number }, plan: Plan) => ({
  id: r.id,
  slug: r.slug,
  title: r.title,
  summary: r.summary,
  level: r.level,
  goal: r.goal,
  weeks: r.weeks,
  daysPerWeek: r.days_per_week,
  equipment: parseList(r.equipment, EQUIPMENT),
  coverMediaId: r.cover_media_id,
  tier: r.tier,
  author: r.author,
  workoutCount: r.workout_count,
  locked: locked(r.tier, plan),
}); // fmt: skip

const effectiveTier = (w: Pick<WorkoutRow, 'tier_override'>, program: Tier): Tier =>
  w.tier_override ?? program;

const outlineOf = (w: WorkoutRow & { exercise_count: number }, programTier: Tier, plan: Plan) => {
  const tier = effectiveTier(w, programTier);
  return {
    id: w.id,
    key: w.key,
    title: w.title,
    estMinutes: w.est_minutes,
    exerciseCount: w.exercise_count,
    tier,
    locked: locked(tier, plan),
  };
};

export class WorkoutsService {
  constructor(
    private repo: WorkoutsRepo,
    private planOf: (userId: string) => Promise<Plan>,
    private clock: Clock,
  ) {}

  async listExercises(q: {
    q?: string;
    muscle?: string;
    equipment?: string;
    difficulty?: string;
    limit: number;
    cursor?: string;
  }) {
    const after = decodeCursor<{ n: string; i: string }>(q.cursor, ['n', 'i']);
    const rows = await this.repo.searchExercises(
      {
        tokens: q.q ? normalizeName(q.q).split(' ').filter(Boolean).slice(0, 5) : [],
        muscle: q.muscle,
        equipment: q.equipment,
        difficulty: q.difficulty,
      },
      after ? { name: after.n, id: after.i } : null,
      q.limit + 1,
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toExercise),
      nextCursor: rows.length > q.limit && last ? encodeCursor({ n: last.name_norm, i: last.id }) : null,
    };
  }

  async getExercise(slug: string) {
    const r = await this.repo.getExerciseBySlug(slug);
    if (!r) throw notFound('Exercise');
    return toExercise(r);
  }

  async listPrograms(userId: string, f: { level?: string; goal?: string; tier?: string }) {
    const plan = await this.planOf(userId);
    return { items: (await this.repo.listPrograms(f)).map((p) => toProgramSummary(p, plan)) };
  }

  async getProgram(userId: string, slug: string) {
    const plan = await this.planOf(userId);
    const program = await this.repo.getPublishedProgramBySlug(slug);
    if (!program) throw notFound('Program');
    const weeks = new Map<number, Map<number, ReturnType<typeof outlineOf>[]>>();
    for (const w of await this.repo.outline(program.id)) {
      const days = weeks.get(w.week) ?? new Map();
      days.set(w.day, [...(days.get(w.day) ?? []), outlineOf(w, program.tier, plan)]);
      weeks.set(w.week, days);
    }
    const schedule = [...weeks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([week, days]) => ({
        week,
        days: [...days.entries()].sort(([a], [b]) => a - b).map(([day, workouts]) => ({ day, workouts })),
      }));
    return { ...toProgramSummary(program, plan), description: program.description, schedule };
  }

  /** A workout with its exercises. Pro workouts need a Pro account (some Pro programs have free sample workouts). */
  async getWorkout(userId: string, id: string) {
    const w = await this.repo.getWorkout(id);
    if (!w) throw notFound('Workout');
    const tier = effectiveTier(w, w.program_tier);
    if (locked(tier, await this.planOf(userId))) throw subscriptionRequired('This workout');
    const rows = await this.repo.workoutExercises(id);
    const exercises = new Map(
      (await this.repo.exercisesByIds(rows.map((r) => r.exercise_id))).map((e) => [e.id, e]),
    );
    return {
      id: w.id,
      key: w.key,
      programSlug: w.program_slug,
      programTitle: w.program_title,
      week: w.week,
      day: w.day,
      title: w.title,
      notes: w.notes,
      estMinutes: w.est_minutes,
      tier,
      exercises: rows.map((x: WorkoutExerciseRow) => ({
        position: x.position,
        exercise: toExercise(exercises.get(x.exercise_id)!),
        sets: x.sets,
        repsMin: x.reps_min,
        repsMax: x.reps_max,
        durationS: x.duration_s,
        restS: x.rest_s,
        notes: x.notes,
      })),
    }; // fmt: skip
  }

  // ---- following a program -------------------------------------------------------------------------------------

  async enroll(userId: string, slug: string) {
    const program = await this.repo.getPublishedProgramBySlug(slug);
    if (!program) throw notFound('Program');
    if (locked(program.tier, await this.planOf(userId))) throw subscriptionRequired('This program');
    if (program.workout_count === 0) throw badRequest('This program has no workouts yet');
    await this.repo.enroll(userId, program.id, newId(this.clock.now()), this.clock.now());
    return this.current(userId);
  }

  async leave(userId: string, slug: string) {
    const program = await this.repo.getPublishedProgramBySlug(slug);
    if (program) await this.repo.leave(userId, program.id, this.clock.now());
  }

  async current(userId: string) {
    const enrollment = await this.repo.getActiveEnrollment(userId);
    if (!enrollment) return { enrollment: null };
    const view = await this.enrollmentView(userId, enrollment);
    return { enrollment: view };
  }

  private async enrollmentView(userId: string, e: EnrollmentRow) {
    const plan = await this.planOf(userId);
    const program = await this.repo.getPublishedProgramById(e.program_id);
    if (!program) return null; // the program was unpublished while they followed it
    const outline = await this.repo.outline(program.id);
    const done = await this.repo.completedWorkoutIds(userId, program.id);
    const next = outline.find((w) => !done.has(w.id));
    return {
      program: toProgramSummary(program, plan),
      status: e.status,
      startedAt: e.started_at,
      progress: {
        completedWorkouts: outline.filter((w) => done.has(w.id)).length,
        totalWorkouts: outline.length,
        nextWorkout: next ? { ...outlineOf(next, program.tier, plan), week: next.week, day: next.day } : null,
      },
    };
  }

  /** After a session is logged against a program: if every workout has now been done, the program is finished. */
  async afterSession(userId: string, programId: string): Promise<void> {
    const program = await this.repo.getPublishedProgramById(programId);
    if (!program) return;
    const outline = await this.repo.outline(program.id);
    const done = await this.repo.completedWorkoutIds(userId, program.id);
    if (outline.length > 0 && outline.every((w) => done.has(w.id)))
      await this.repo.markCompleted(userId, program.id, this.clock.now());
  }
}
