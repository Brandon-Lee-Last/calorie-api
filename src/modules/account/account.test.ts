import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { newId } from '../../core/ids';
import { MemoryRateLimiter } from '../../core/rate-limiter';
import { FakeClock } from '../../core/time';
import { GOOGLE_CLIENT, makeGoogle } from '../../../test/helpers/google';
import { T0, authed, body, jsonInit, makeApp, signUp } from '../../../test/helpers/app';

const TODAY = '2026-10-21';
const CONFIRM = { confirm: 'DELETE MY ACCOUNT' };
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

/** An account with a bit of everything in it. */
async function populated(t: ReturnType<typeof makeApp>) {
  const s = await signUp(t);
  const send = (method: string, path: string, data?: unknown, token = s.accessToken) =>
    t.request(path, jsonInit(method, data, token));
  const meal = newId();
  await send('PUT', `/v1/diary/entries/${meal}`, {
    loggedAt: T0,
    localDate: TODAY,
    mealType: 'lunch',
    name: 'Bunny chow',
    calories: 640,
    source: 'scan',
    clientUpdatedAt: T0,
  });
  await t.request(`/v1/diary/entries/${meal}/photo`, {
    method: 'PUT',
    headers: { 'content-type': 'image/jpeg', ...authed(s.accessToken) },
    body: jpeg as BodyInit,
  });
  const gone = newId();
  await send('PUT', `/v1/diary/entries/${gone}`, {
    loggedAt: T0,
    localDate: TODAY,
    mealType: 'snack',
    name: 'Deleted snack',
    calories: 99,
    source: 'manual',
    clientUpdatedAt: T0,
  });
  await send('DELETE', `/v1/diary/entries/${gone}`);
  await send('PUT', `/v1/weight/${newId()}`, {
    loggedAt: T0,
    localDate: TODAY,
    weightKg: 82.5,
    clientUpdatedAt: T0,
  });
  await send('PUT', `/v1/water/${newId()}`, { loggedAt: T0, localDate: TODAY, ml: 500, clientUpdatedAt: T0 });
  await send('PUT', `/v1/foods/${newId()}`, {
    name: 'Gran’s rusks',
    calories100g: 430,
    protein100g: 9,
    carb100g: 70,
    fat100g: 12,
    clientUpdatedAt: T0,
  });
  const scan = newId();
  await send('PUT', `/v1/scans/${scan}`, {
    modelVersion: 'nutrition_v1',
    outcome: 'saved',
    contributeConsent: true,
    clientCreatedAt: T0,
  });
  await t.request(`/v1/scans/${scan}/photo`, {
    method: 'PUT',
    headers: { 'content-type': 'image/jpeg', ...authed(s.accessToken) },
    body: jpeg as BodyInit,
  });
  await send('PUT', `/v1/training/sessions/${newId()}`, {
    title: 'Legs',
    startedAt: T0 - 3_600_000,
    finishedAt: T0 - 600_000,
    localDate: TODAY,
    sets: [{ exercise: 'squat', setNo: 1, reps: 5, weightKg: 100 }],
    clientUpdatedAt: T0,
  });
  await send('PUT', `/v1/recipes/${newId()}`, {
    name: 'Pap and wors',
    servings: 2,
    ingredients: [{ name: 'Pap', calories: 300, proteinG: 8, carbG: 60, fatG: 2 }],
    clientUpdatedAt: T0,
  });
  await send('PUT', `/v1/activity/${newId()}`, {
    loggedAt: T0,
    localDate: TODAY,
    kind: 'walking',
    durationMin: 45,
    clientUpdatedAt: T0,
  });
  await send('PUT', `/v1/measurements/${newId()}`, {
    loggedAt: T0,
    localDate: TODAY,
    type: 'waist',
    value: 90,
    clientUpdatedAt: T0,
  });
  const progress = newId();
  await send('PUT', `/v1/progress/${progress}`, {
    loggedAt: T0,
    localDate: TODAY,
    pose: 'side',
    clientUpdatedAt: T0,
  });
  await t.request(`/v1/progress/${progress}/photo`, {
    method: 'PUT',
    headers: { 'content-type': 'image/jpeg', ...authed(s.accessToken) },
    body: jpeg as BodyInit,
  });
  await send('PATCH', '/v1/me', { displayName: 'Thandi' });
  return { s, send, meal, scan, progress };
}

const USER_TABLES = [
  'diary_entries',
  'weight_logs',
  'water_logs',
  'foods',
  'scan_events',
  'workout_sessions',
  'recipes',
  'activity_logs',
  'body_measurements',
  'progress_photos',
  'subscriptions',
  'usage_counters',
  'program_enrollments',
  'refresh_tokens',
  'identities',
  'user_profiles',
];

describe('data export', () => {
  it('contains the person’s data, readable, without internal bookkeeping', async () => {
    const t = makeApp();
    const { send, s } = await populated(t);
    const res = await send('GET', '/v1/account/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('my-data.json');
    const data = await body(res);
    expect(data).toMatchObject({
      format: 1,
      exportedAt: T0,
      account: { id: s.userId, displayName: 'Thandi' },
      profile: { timezone: 'UTC', calorieGoal: 2000 },
    });
    expect(data.diaryEntries).toHaveLength(1);
    expect(data.diaryEntries[0]).toMatchObject({ name: 'Bunny chow', calories: 640, hasPhoto: true });
    expect(JSON.stringify(data)).not.toMatch(/photoKey|photo_key|userId|user_id|clientUpdatedAt|\"rev\"/);
    expect(data.weightLogs[0].weightKg).toBe(82.5);
    expect(data.waterLogs[0].ml).toBe(500);
    expect(data.customFoods[0].name).toBe('Gran’s rusks');
    expect(data.scanEvents[0]).toMatchObject({ modelVersion: 'nutrition_v1', contributeConsent: 1 });
    expect(data.workoutSessions[0]).toMatchObject({ title: 'Legs', sets: [{ exercise: 'squat', reps: 5 }] });
    expect(data.recipes[0]).toMatchObject({
      name: 'Pap and wors',
      servings: 2,
      ingredients: [{ name: 'Pap', calories: 300 }],
    });
    expect(data.activityLogs[0]).toMatchObject({ kind: 'walking', durationMin: 45, caloriesEstimated: 1 });
    expect(data.bodyMeasurements[0]).toMatchObject({ type: 'waist', value: 90 });
    expect(data.progressPhotos[0]).toMatchObject({ pose: 'side', hasPhoto: true });
  });
  it('leaves out deleted items and other people', async () => {
    const t = makeApp();
    const { send } = await populated(t);
    await populated(t); // somebody else
    const data = await body(await send('GET', '/v1/account/export'));
    expect(JSON.stringify(data)).not.toContain('Deleted snack');
    expect(data.diaryEntries).toHaveLength(1);
  });
  it('needs sign-in and is rate limited', async () => {
    const clock = new FakeClock(T0);
    const t = makeApp({ clock, rateLimiter: new MemoryRateLimiter(clock) });
    expect((await t.request('/v1/account/export')).status).toBe(401);
    const s = await signUp(t);
    let last = 0;
    for (let i = 0; i < 6; i++)
      last = (await t.request('/v1/account/export', { headers: authed(s.accessToken) })).status;
    expect(last).toBe(429);
  });
});

describe('deleting the account', () => {
  it('needs the exact confirmation', async () => {
    const t = makeApp();
    const s = await signUp(t);
    for (const bad of [{}, { confirm: 'yes' }, { confirm: 'delete my account' }]) {
      expect((await t.request('/v1/account', jsonInit('DELETE', bad, s.accessToken))).status).toBe(422);
    }
    expect((await t.request('/v1/me', { headers: authed(s.accessToken) })).status).toBe(200);
    expect((await t.request('/v1/account', jsonInit('DELETE', CONFIRM))).status).toBe(401);
  });
  it('erases every row and every stored file, and ends all sessions', async () => {
    const t = makeApp();
    const { s, send, meal, scan, progress } = await populated(t);
    expect(await env.MEDIA.head(`users/${s.userId}/meals/${meal}.jpg`)).not.toBeNull();
    expect(await env.MEDIA.head(`contrib/${s.userId}/${scan}.jpg`)).not.toBeNull();

    const res = await send('DELETE', '/v1/account', CONFIRM);
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ deleted: true, subscriptionNote: null });

    for (const table of USER_TABLES) {
      const column = table === 'user_profiles' ? 'user_id' : 'user_id';
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
        .bind(s.userId)
        .first<{ n: number }>();
      expect(n!.n, table).toBe(0);
    }
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?')
        .bind(s.userId)
        .first<{ n: number }>())!.n,
    ).toBe(0);
    expect(await env.MEDIA.head(`users/${s.userId}/meals/${meal}.jpg`)).toBeNull();
    expect(await env.MEDIA.head(`contrib/${s.userId}/${scan}.jpg`)).toBeNull();
    expect(await env.MEDIA.head(`users/${s.userId}/progress/${progress}.jpg`)).toBeNull();

    // the old tokens are dead straight away, not after 15 minutes
    const me = await send('GET', '/v1/me');
    expect(me.status).toBe(401);
    expect((await body(me)).error.message).toMatch(/no longer exists/);
    expect(
      (
        await send('PUT', `/v1/weight/${newId()}`, {
          loggedAt: T0,
          localDate: TODAY,
          weightKg: 70,
          clientUpdatedAt: T0,
        })
      ).status,
    ).toBe(401);
    expect(
      (await t.request('/v1/auth/refresh', jsonInit('POST', { refreshToken: s.refreshToken }))).status,
    ).toBe(401);
    expect((await send('DELETE', '/v1/account', CONFIRM)).status).toBe(401);
  });
  it('leaves other people’s data alone', async () => {
    const t = makeApp();
    const a = await populated(t);
    const b = await populated(t);
    await a.send('DELETE', '/v1/account', CONFIRM);
    const data = await body(await b.send('GET', '/v1/account/export'));
    expect(data.diaryEntries).toHaveLength(1);
    expect(await env.MEDIA.head(`users/${b.s.userId}/meals/${b.meal}.jpg`)).not.toBeNull();
  });
  it('reminds a paying person to cancel in the store', async () => {
    const t = makeApp();
    const s = await signUp(t);
    await t.request('/v1/subscription/simulate', jsonInit('POST', { scenario: 'subscribe' }, s.accessToken));
    const res = await body(await t.request('/v1/account', jsonInit('DELETE', CONFIRM, s.accessToken)));
    expect(res.subscriptionNote).toMatch(/Cancel it in the store/);
  });
  it('lets the same Google account start again afterwards', async () => {
    const clock = new FakeClock(T0);
    const g = await makeGoogle(clock);
    const t = makeApp({ clock, googleVerifier: g.verifier });
    const first = await body(
      await t.request('/v1/auth/google', jsonInit('POST', { idToken: await g.issue({ sub: 'erase-me' }) })),
    );
    await t.request('/v1/account', jsonInit('DELETE', CONFIRM, first.accessToken));
    const again = await body(
      await t.request('/v1/auth/google', jsonInit('POST', { idToken: await g.issue({ sub: 'erase-me' }) })),
    );
    expect(again).toMatchObject({ created: true, isAnonymous: false });
    expect(again.userId).not.toBe(first.userId);
    void GOOGLE_CLIENT;
  });
});
