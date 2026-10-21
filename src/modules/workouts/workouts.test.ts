import { beforeEach, describe, expect, it } from 'vitest';
import { adminClient, exerciseBody, resetContent, seedLibrary } from '../../../test/helpers/content';
import { T0, body, jsonInit, makeApp, signUp } from '../../../test/helpers/app';
import { newId } from '../../core/ids';
import { DAY } from '../../core/time';

beforeEach(resetContent);

async function setup() {
  const t = makeApp();
  const lib = await seedLibrary(t);
  const s = await signUp(t);
  const send = (method: string, path: string, data?: unknown, token = s.accessToken) =>
    t.request(path, jsonInit(method, data, token));
  const goPro = () => send('POST', '/v1/subscription/simulate', { scenario: 'subscribe' });
  const program = async (slug: string) => body(await send('GET', `/v1/programs/${slug}`));
  const workoutId = async (slug: string, key: string) => {
    const p = await program(slug);
    return p.schedule
      .flatMap((w: any) => w.days.flatMap((d: any) => d.workouts))
      .find((w: any) => w.key === key).id as string;
  };
  return { t, s, send, goPro, program, workoutId, ...lib };
}

describe('exercise library', () => {
  it('lists A to Z and pages with a cursor', async () => {
    const { send } = await setup();
    const first = await body(await send('GET', '/v1/exercises?limit=3'));
    expect(first.items.map((e: { slug: string }) => e.slug)).toEqual([
      'barbell-back-squat',
      'bench-press',
      'bent-over-row',
    ]);
    expect(first.nextCursor).toBeTruthy();
    const second = await body(await send('GET', `/v1/exercises?limit=3&cursor=${first.nextCursor}`));
    expect(second.items.map((e: { slug: string }) => e.slug)).toEqual(['plank']);
    expect(second.nextCursor).toBeNull();
    expect((await send('GET', '/v1/exercises?cursor=junk')).status).toBe(400);
  });
  it('filters by name, muscle, equipment and difficulty', async () => {
    const { send } = await setup();
    const slugs = async (q: string) =>
      (await body(await send('GET', `/v1/exercises?${q}`))).items.map((e: { slug: string }) => e.slug);
    expect(await slugs('q=bench')).toEqual(['bench-press']);
    expect(await slugs('q=BENT%20row')).toEqual(['bent-over-row']);
    expect(await slugs('muscle=abs')).toEqual(['plank']);
    expect(await slugs('equipment=barbell')).toEqual(['barbell-back-squat', 'bench-press', 'bent-over-row']);
    expect(await slugs('difficulty=beginner')).toEqual(['bent-over-row', 'plank']);
    expect(await slugs('muscle=chest&equipment=barbell&difficulty=intermediate')).toEqual(['bench-press']);
    expect(await slugs('q=zzz')).toEqual([]);
    expect((await send('GET', '/v1/exercises?muscle=wings')).status).toBe(422);
  });
  it('shows one exercise in full, and 404s the rest', async () => {
    const { send } = await setup();
    expect(await body(await send('GET', '/v1/exercises/plank'))).toMatchObject({
      name: 'Plank',
      muscleGroups: ['abs'],
      equipment: ['bodyweight'],
      difficulty: 'beginner',
    });
    expect((await send('GET', '/v1/exercises/levitation')).status).toBe(404);
  });
  it('needs sign-in', async () => {
    const { t } = await setup();
    expect((await t.request('/v1/exercises')).status).toBe(401);
    expect((await t.request('/v1/programs')).status).toBe(401);
  });
});

describe('programs and gating', () => {
  it('lists published programs, marking Pro ones as locked for a free account', async () => {
    const { send, goPro } = await setup();
    const free = await body(await send('GET', '/v1/programs'));
    expect(free.items.map((p: any) => [p.slug, p.tier, p.locked, p.workoutCount])).toEqual([
      ['beginner-strength', 'free', false, 3],
      ['mass-builder', 'pro', true, 2],
    ]);
    await goPro();
    expect((await body(await send('GET', '/v1/programs'))).items.map((p: any) => p.locked)).toEqual([
      false,
      false,
    ]);
  });
  it('filters by level, goal and tier', async () => {
    const { send } = await setup();
    const slugs = async (q: string) =>
      (await body(await send('GET', `/v1/programs?${q}`))).items.map((p: { slug: string }) => p.slug);
    expect(await slugs('level=beginner')).toEqual(['beginner-strength']);
    expect(await slugs('goal=muscle')).toEqual(['mass-builder']);
    expect(await slugs('tier=pro')).toEqual(['mass-builder']);
    expect(await slugs('tier=free&goal=muscle')).toEqual([]);
  });
  it('shows the week by week schedule, with locks on Pro workouts except the free sample', async () => {
    const { program } = await setup();
    const free = await program('beginner-strength');
    expect(free).toMatchObject({
      title: 'Beginner Strength',
      weeks: 4,
      daysPerWeek: 3,
      equipment: ['barbell', 'bench'],
      author: 'Coach A',
      description: '# Welcome',
    });
    expect(free.schedule.map((w: any) => [w.week, w.days.map((d: any) => d.day)])).toEqual([
      [1, [1, 3]],
      [2, [1]],
    ]);
    expect(free.schedule[0].days[0].workouts[0]).toMatchObject({
      key: 'w1d1',
      exerciseCount: 2,
      estMinutes: 45,
      tier: 'free',
      locked: false,
    });

    const pro = await program('mass-builder');
    const flat = pro.schedule.flatMap((w: any) => w.days.flatMap((d: any) => d.workouts));
    expect(flat.map((w: any) => [w.key, w.tier, w.locked])).toEqual([
      ['w1d1', 'free', false],
      ['w1d2', 'pro', true],
    ]);
  });
  it('opens a workout with its exercises, in order, and enforces Pro', async () => {
    const { send, workoutId, goPro } = await setup();
    const sample = await body(await send('GET', `/v1/workouts/${await workoutId('mass-builder', 'w1d1')}`));
    expect(sample).toMatchObject({
      key: 'w1d1',
      programSlug: 'mass-builder',
      title: 'Sample day',
      tier: 'free',
    });
    const open = await body(
      await send('GET', `/v1/workouts/${await workoutId('beginner-strength', 'w1d1')}`),
    );
    expect(open.exercises.map((e: any) => e.exercise.slug)).toEqual(['barbell-back-squat', 'bench-press']);
    expect(open.exercises[0]).toMatchObject({
      position: 0,
      sets: 3,
      repsMin: 8,
      repsMax: 12,
      restS: 90,
      durationS: null,
    });

    const lockedId = await workoutId('mass-builder', 'w1d2');
    const denied = await send('GET', `/v1/workouts/${lockedId}`);
    expect(denied.status).toBe(402);
    expect((await body(denied)).error.code).toBe('subscription_required');
    await goPro();
    expect((await send('GET', `/v1/workouts/${lockedId}`)).status).toBe(200);
    expect((await send('GET', `/v1/workouts/${newId()}`)).status).toBe(404);
    expect((await send('GET', '/v1/workouts/not-an-id')).status).toBe(422);
  });
  it('stops being Pro access when the subscription ends', async () => {
    const { send, workoutId, goPro } = await setup();
    const lockedId = await workoutId('mass-builder', 'w1d2');
    await goPro();
    expect((await send('GET', `/v1/workouts/${lockedId}`)).status).toBe(200);
    await send('POST', '/v1/subscription/simulate', { scenario: 'expire' });
    expect((await send('GET', `/v1/workouts/${lockedId}`)).status).toBe(402);
  });
});

describe('following a program', () => {
  it('starts with none, and enrolling shows progress and the next workout', async () => {
    const { send, workoutId } = await setup();
    expect(await body(await send('GET', '/v1/programs/current'))).toEqual({ enrollment: null });
    const res = await send('POST', '/v1/programs/beginner-strength/enroll');
    expect(res.status).toBe(200);
    const { enrollment } = await body(res);
    expect(enrollment).toMatchObject({
      status: 'active',
      startedAt: T0,
      program: { slug: 'beginner-strength' },
      progress: {
        completedWorkouts: 0,
        totalWorkouts: 3,
        nextWorkout: { key: 'w1d1', week: 1, day: 1, id: await workoutId('beginner-strength', 'w1d1') },
      },
    }); // fmt: skip
    expect(
      (await body(await send('POST', '/v1/programs/beginner-strength/enroll'))).enrollment.startedAt,
    ).toBe(T0); // idempotent
  });
  it('is Pro only for Pro programs, and unknown programs 404', async () => {
    const { send, goPro } = await setup();
    const denied = await send('POST', '/v1/programs/mass-builder/enroll');
    expect(denied.status).toBe(402);
    expect((await send('POST', '/v1/programs/nope/enroll')).status).toBe(404);
    await goPro();
    expect((await send('POST', '/v1/programs/mass-builder/enroll')).status).toBe(200);
  });
  it('follows one program at a time and can stop', async () => {
    const { send, goPro } = await setup();
    await goPro();
    await send('POST', '/v1/programs/beginner-strength/enroll');
    await send('POST', '/v1/programs/mass-builder/enroll');
    expect((await body(await send('GET', '/v1/programs/current'))).enrollment.program.slug).toBe(
      'mass-builder',
    );
    expect((await send('DELETE', '/v1/programs/mass-builder/enroll')).status).toBe(204);
    expect((await send('DELETE', '/v1/programs/mass-builder/enroll')).status).toBe(204);
    expect((await body(await send('GET', '/v1/programs/current'))).enrollment).toBeNull();
  });
  it('advances as workouts are logged, and completes the program after the last one', async () => {
    const { send, workoutId, program } = await setup();
    await send('POST', '/v1/programs/beginner-strength/enroll');
    const programId = (await program('beginner-strength')).id;
    const log = async (key: string, finished = true) =>
      send('PUT', `/v1/training/sessions/${newId()}`, {
        workoutId: await workoutId('beginner-strength', key),
        programId,
        title: key,
        startedAt: T0 - 3_600_000,
        finishedAt: finished ? T0 - 600_000 : null,
        localDate: '2026-10-21',
        sets: [{ exercise: 'plank', setNo: 1, durationS: 60 }],
        clientUpdatedAt: T0,
      }); // fmt: skip
    const next = async () => (await body(await send('GET', '/v1/programs/current'))).enrollment?.progress;

    await log('w1d1', false); // started but not finished: no progress
    expect((await next()).completedWorkouts).toBe(0);
    await log('w1d1');
    expect(await next()).toMatchObject({ completedWorkouts: 1, nextWorkout: { key: 'w1d2' } });
    await log('w1d1'); // doing the same workout again does not count twice
    expect((await next()).completedWorkouts).toBe(1);
    await log('w1d2');
    await log('w2d1');
    expect(await next()).toBeUndefined(); // enrolment is no longer active: the program is complete
    const done = await send('POST', '/v1/programs/beginner-strength/enroll'); // and can be started again
    expect(done.status).toBe(200);
  });
  it('ignores an unpublished program for someone who was following it', async () => {
    const { send, admin } = await setup();
    await send('POST', '/v1/programs/beginner-strength/enroll');
    await admin.call('POST', '/v1/admin/programs/beginner-strength/unpublish');
    expect((await body(await send('GET', '/v1/programs/current'))).enrollment).toBeNull();
  });
  it('keeps people apart', async () => {
    const { t, send } = await setup();
    await send('POST', '/v1/programs/beginner-strength/enroll');
    const other = await signUp(t);
    expect(
      (await body(await send('GET', '/v1/programs/current', undefined, other.accessToken))).enrollment,
    ).toBeNull();
  });
});

describe('exercise library edge cases', () => {
  it('ignores bad values stored in the JSON columns instead of failing', async () => {
    const { admin, send } = await setup();
    await admin.call(
      'PUT',
      '/v1/admin/exercises/odd',
      exerciseBody({ name: 'Odd', muscleGroups: ['chest'] }),
    );
    const { env } = await import('cloudflare:workers');
    await env.DB.prepare(
      "UPDATE exercises SET muscle_groups = 'not json', equipment = '[\"barbell\",\"warp-drive\"]' WHERE slug = 'odd'",
    ).run();
    const ex = await body(await send('GET', '/v1/exercises/odd'));
    expect(ex.muscleGroups).toEqual([]);
    expect(ex.equipment).toEqual(['barbell']);
    void DAY;
  });
});
