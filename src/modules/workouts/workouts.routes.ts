import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { authErrors, bearer, commonErrors, json } from '../../core/openapi';
import { requireAuth } from '../../middleware/auth';
import {
  currentEnrollmentSchema,
  exerciseListSchema,
  exerciseQuerySchema,
  exerciseSchema,
  programDetailSchema,
  programListSchema,
  programQuerySchema,
  slugParam,
  workoutDetailSchema,
  workoutIdParam,
} from './workouts.schemas'; // fmt: skip

export const workoutsRoutes = new OpenAPIHono<AppEnv>();
const secured = { security: bearer, middleware: [requireAuth] };
const uid = (c: { get(k: 'auth'): { userId: string } | undefined }) => c.get('auth')!.userId;

workoutsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/exercises',
    tags: ['Workouts'],
    summary: 'The exercise library',
    ...secured,
    description:
      'Search by name and filter by muscle, equipment and difficulty. Pages are cursor based: pass `nextCursor` back as `cursor`.',
    request: { query: exerciseQuerySchema },
    responses: { 200: json(exerciseListSchema, 'Exercises, A to Z'), ...authErrors },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').workouts.listExercises(c.req.valid('query')), 200),
);

workoutsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/exercises/{slug}',
    tags: ['Workouts'],
    summary: 'One exercise',
    ...secured,
    request: { params: slugParam },
    responses: { 200: json(exerciseSchema, 'The exercise'), 404: commonErrors[400], ...authErrors },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').workouts.getExercise(c.req.valid('param').slug), 200),
);

workoutsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/programs',
    tags: ['Workouts'],
    summary: 'Published programs, free and Pro',
    ...secured,
    description:
      '`locked` is true for Pro programs when the account is on the free plan: show them with a lock and an upgrade prompt.',
    request: { query: programQuerySchema },
    responses: { 200: json(programListSchema, 'Programs'), ...authErrors },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').workouts.listPrograms(uid(c), c.req.valid('query')), 200),
);

// Static path before "{slug}".
workoutsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/programs/current',
    tags: ['Workouts'],
    summary: 'The program this person is following, with progress and the next workout',
    ...secured,
    responses: {
      200: json(currentEnrollmentSchema, '`enrollment` is null when not following one'),
      ...authErrors,
    },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').workouts.current(uid(c)), 200),
);

workoutsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/programs/{slug}',
    tags: ['Workouts'],
    summary: 'A program’s week-by-week schedule',
    ...secured,
    request: { params: slugParam },
    responses: { 200: json(programDetailSchema, 'The program'), 404: commonErrors[400], ...authErrors },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').workouts.getProgram(uid(c), c.req.valid('param').slug), 200),
);

workoutsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/programs/{slug}/enroll',
    tags: ['Workouts'],
    summary: 'Start following a program (leaving the one before)',
    ...secured,
    request: { params: slugParam },
    responses: {
      200: json(currentEnrollmentSchema, 'Now following it'),
      402: commonErrors[400],
      404: commonErrors[400],
      ...authErrors,
    },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').workouts.enroll(uid(c), c.req.valid('param').slug), 200),
);

workoutsRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/programs/{slug}/enroll',
    tags: ['Workouts'],
    summary: 'Stop following a program',
    ...secured,
    request: { params: slugParam },
    responses: {
      204: { description: 'Stopped (also returned if they were not following it)' },
      ...authErrors,
    },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').workouts.leave(uid(c), c.req.valid('param').slug);
    return c.body(null, 204);
  },
);

workoutsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/workouts/{id}',
    tags: ['Workouts'],
    summary: 'A workout with its exercises, sets and reps',
    ...secured,
    description:
      '402 `subscription_required` for a Pro workout on a free account. Some Pro programs have free sample workouts.',
    request: { params: workoutIdParam },
    responses: {
      200: json(workoutDetailSchema, 'The workout'),
      402: commonErrors[400],
      404: commonErrors[400],
      ...authErrors,
    },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').workouts.getWorkout(uid(c), c.req.valid('param').id), 200),
);
