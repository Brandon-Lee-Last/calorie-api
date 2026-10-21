import { env } from 'cloudflare:workers';
import { body, type TestApp } from './app';

/** Content tables persist between tests in a file, so each test starts from an empty library. */
export async function resetContent() {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM program_enrollments'),
    env.DB.prepare('DELETE FROM workout_exercises'),
    env.DB.prepare('DELETE FROM workouts'),
    env.DB.prepare('DELETE FROM programs'),
    env.DB.prepare('DELETE FROM exercises'),
    env.DB.prepare('DELETE FROM media'),
  ]);
}

/** Calls the admin API with the test admin key. */
export function adminClient(t: TestApp) {
  const call = (method: string, path: string, data?: unknown, extra: Record<string, string> = {}) =>
    t.request(path, {
      method,
      headers: {
        'x-admin-key': env.ADMIN_API_KEY,
        ...(data === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  const upload = (key: string, bytes: Uint8Array, type: string) =>
    t.request(`/v1/admin/media/${key}/upload`, {
      method: 'PUT',
      headers: { 'x-admin-key': env.ADMIN_API_KEY, 'content-type': type },
      body: bytes as BodyInit,
    });
  return { call, upload };
}

export const exerciseBody = (over: Record<string, unknown> = {}) => ({
  name: 'Barbell Back Squat',
  muscleGroups: ['quads', 'glutes'],
  equipment: ['barbell'],
  difficulty: 'intermediate',
  instructions: 'Bar on your upper back. Sit down and back, then stand.',
  tips: 'Brace before you descend.',
  source: 'Our own content',
  licence: 'Owned',
  ...over,
}); // fmt: skip

export const workout = (
  key: string,
  week: number,
  day: number,
  slugs: string[],
  over: Record<string, unknown> = {},
) => ({
  key,
  week,
  day,
  title: `Week ${week} day ${day}`,
  estMinutes: 45,
  exercises: slugs.map((exerciseSlug) => ({ exerciseSlug, sets: 3, repsMin: 8, repsMax: 12, restS: 90 })),
  ...over,
}); // fmt: skip

export const programBody = (workouts: unknown[], over: Record<string, unknown> = {}) => ({
  title: 'Beginner Strength',
  summary: 'Three days a week to build a base.',
  description: '# Welcome',
  level: 'beginner',
  goal: 'strength',
  weeks: 4,
  daysPerWeek: 3,
  equipment: ['barbell', 'bench'],
  tier: 'free',
  author: 'Coach A',
  workouts,
  ...over,
}); // fmt: skip

/** A small library: three exercises, a free program, and a Pro program with one free sample workout. */
export async function seedLibrary(t: TestApp) {
  const admin = adminClient(t);
  for (const [slug, over] of [
    ['barbell-back-squat', {}],
    [
      'bench-press',
      { name: 'Bench Press', muscleGroups: ['chest', 'triceps'], equipment: ['barbell', 'bench'] },
    ],
    ['bent-over-row', { name: 'Bent-Over Row', muscleGroups: ['back', 'lats'], difficulty: 'beginner' }],
    ['plank', { name: 'Plank', muscleGroups: ['abs'], equipment: ['bodyweight'], difficulty: 'beginner' }],
  ] as const) {
    const res = await admin.call('PUT', `/v1/admin/exercises/${slug}`, exerciseBody(over));
    if (res.status !== 200) throw new Error(`seed exercise ${slug}: ${res.status} ${await res.text()}`);
  }
  const free = await admin.call(
    'PUT',
    '/v1/admin/programs/beginner-strength',
    programBody([
      workout('w1d1', 1, 1, ['barbell-back-squat', 'bench-press']),
      workout('w1d2', 1, 3, ['bent-over-row', 'plank']),
      workout('w2d1', 2, 1, ['barbell-back-squat', 'bench-press', 'bent-over-row']),
    ]),
  ); // fmt: skip
  if (free.status !== 200) throw new Error(`seed free program: ${free.status} ${await free.text()}`);
  const pro = await admin.call(
    'PUT',
    '/v1/admin/programs/mass-builder',
    programBody(
      [
        workout('w1d1', 1, 1, ['barbell-back-squat'], { tierOverride: 'free', title: 'Sample day' }),
        workout('w1d2', 1, 2, ['bench-press', 'bent-over-row']),
      ],
      { title: 'Mass Builder', tier: 'pro', level: 'intermediate', goal: 'muscle', weeks: 8, position: 1 },
    ),
  ); // fmt: skip
  if (pro.status !== 200) throw new Error(`seed pro program: ${pro.status} ${await pro.text()}`);
  await admin.call('POST', '/v1/admin/programs/beginner-strength/publish');
  await admin.call('POST', '/v1/admin/programs/mass-builder/publish');
  return { admin, free: await body(free), pro: await body(pro) };
}
