import { describe, expect, it } from 'vitest';
import { FakeAi } from '../../../test/helpers/ai';
import { T0, body, jsonInit, makeApp, signUp } from '../../../test/helpers/app';
import { newId } from '../../core/ids';
import { DAY, HOUR } from '../../core/time';

async function setup() {
  const ai = new FakeAi();
  const t = makeApp({ ai });
  const s = await signUp(t);
  const session = { token: s.accessToken };
  const send = (method: string, path: string, data?: unknown, token = session.token) =>
    t.request(path, jsonInit(method, data, token));
  const day = (offset: number) => new Date(T0 + offset * DAY).toISOString().slice(0, 10);
  const meal = (offset: number, calories: number, over: Record<string, unknown> = {}) =>
    send('PUT', `/v1/diary/entries/${newId()}`, {
      loggedAt: T0 + offset * DAY,
      localDate: day(offset),
      mealType: 'lunch',
      name: 'Lunch',
      calories,
      proteinG: calories / 20,
      carbG: calories / 10,
      fatG: calories / 40,
      source: 'manual',
      clientUpdatedAt: T0,
      ...over,
    }); // fmt: skip
  const pro = () => send('POST', '/v1/subscription/simulate', { scenario: 'subscribe' });
  return { t, s, ai, send, meal, day, pro, session };
}

describe('GET /insights/overview', () => {
  it('is empty for a new account', async () => {
    const { send } = await setup();
    expect(await body(await send('GET', '/v1/insights/overview'))).toEqual({
      date: '2026-10-21',
      streakDays: 0,
      loggedToday: false,
      today: { calories: 0, proteinG: 0, carbG: 0, fatG: 0, waterMl: 0, entries: 0 },
      goals: { calories: 2000, proteinG: 125, carbG: 225, fatG: 67 },
    }); // fmt: skip
  });
  it('shows today’s totals and a streak that survives an empty today', async () => {
    const { send, meal } = await setup();
    await meal(-2, 1800);
    await meal(-1, 2000);
    let o = await body(await send('GET', '/v1/insights/overview'));
    expect(o).toMatchObject({ streakDays: 2, loggedToday: false });
    await meal(0, 500);
    await meal(0, 700);
    await send('PUT', `/v1/water/${newId()}`, {
      loggedAt: T0,
      localDate: '2026-10-21',
      ml: 400,
      clientUpdatedAt: T0,
    });
    o = await body(await send('GET', '/v1/insights/overview'));
    expect(o).toMatchObject({
      streakDays: 3,
      loggedToday: true,
      today: { calories: 1200, waterMl: 400, entries: 2 },
    });
  });
  it('breaks the streak on a missed day', async () => {
    const { send, meal } = await setup();
    await meal(0, 500);
    await meal(-1, 500);
    await meal(-3, 500);
    expect((await body(await send('GET', '/v1/insights/overview'))).streakDays).toBe(2);
  });
  it('uses the person\u2019s own timezone to decide what today is', async () => {
    const { t, s, send, session } = await setup();
    await send('PATCH', '/v1/me/profile', { timezone: 'Africa/Johannesburg' });
    expect((await body(await send('GET', '/v1/insights/overview'))).date).toBe('2026-10-21');
    t.clock.advance(10 * HOUR); // 22:00 UTC is already the next day in Johannesburg
    session.token = (
      await body(await t.request('/v1/auth/refresh', jsonInit('POST', { refreshToken: s.refreshToken })))
    ).accessToken;
    expect((await body(await send('GET', '/v1/insights/overview'))).date).toBe('2026-10-22');
  });
  it('needs sign-in', async () => {
    const { t } = await setup();
    expect((await t.request('/v1/insights/overview')).status).toBe(401);
    expect((await t.request('/v1/insights/weekly')).status).toBe(401);
  });
});

describe('GET /insights/weekly', () => {
  it('gives free accounts the basics: seven days, calories, days on target and a streak', async () => {
    const { send, meal } = await setup();
    await meal(-6, 2000);
    await meal(-4, 1900);
    await meal(-2, 2600);
    await meal(0, 2000);
    const w = await body(await send('GET', '/v1/insights/weekly'));
    expect(w.range).toEqual({ from: '2026-10-15', to: '2026-10-21' });
    expect(w.plan).toBe('free');
    expect(w.days).toHaveLength(7);
    expect(w.days.map((d: { entries: number }) => d.entries)).toEqual([1, 0, 1, 0, 1, 0, 1]);
    expect(w.summary).toMatchObject({
      daysLogged: 4,
      avgCalories: 2125,
      calorieGoal: 2000,
      daysOnTarget: 3,
      avgVsGoalPct: 6.3,
      avgProteinG: null,
      avgWaterMl: null,
    });
    expect(w.streakDays).toBe(1);
    expect(w.weight).toBeNull();
    expect(w.training).toBeNull();
    expect(w.previousWeek).toBeNull();
    expect(w.highlights.length).toBeLessThanOrEqual(2);
    expect(w.highlights[0]).toBe('You logged meals on 4 of 7 days.');
    expect(w.narrative).toBeNull();
  });
  it('gives Pro the macros, water, weight, training and the week before', async () => {
    const { send, meal, pro, day } = await setup();
    await pro();
    await meal(-1, 2000);
    await meal(0, 2000);
    await meal(-8, 1500); // the week before
    await send('PUT', `/v1/water/${newId()}`, {
      loggedAt: T0,
      localDate: day(0),
      ml: 2000,
      clientUpdatedAt: T0,
    });
    await send('PUT', `/v1/weight/${newId()}`, {
      loggedAt: T0 - 5 * DAY,
      localDate: day(-5),
      weightKg: 81,
      clientUpdatedAt: T0,
    });
    await send('PUT', `/v1/weight/${newId()}`, {
      loggedAt: T0,
      localDate: day(0),
      weightKg: 80.4,
      clientUpdatedAt: T0,
    });
    await send('PUT', `/v1/training/sessions/${newId()}`, {
      title: 'Legs',
      startedAt: T0 - 3_600_000,
      finishedAt: T0 - 600_000,
      localDate: day(0),
      sets: [],
      clientUpdatedAt: T0,
    });
    const w = await body(await send('GET', '/v1/insights/weekly'));
    expect(w.plan).toBe('pro');
    expect(w.summary).toMatchObject({
      avgCalories: 2000,
      avgProteinG: 100,
      avgCarbG: 200,
      avgFatG: 50,
      avgWaterMl: 2000,
      daysOnTarget: 2,
    });
    expect(w.weight).toEqual({ startKg: 81, endKg: 80.4, changeKg: -0.6 });
    expect(w.training).toEqual({ sessions: 1, minutes: 50 });
    expect(w.previousWeek).toEqual({ daysLogged: 1, avgCalories: 1500 });
    expect(w.highlights).toEqual(
      expect.arrayContaining(['Your logged weight changed by -0.6 kg.', 'You finished 1 workout.']),
    );
  });
  it('can look at an earlier week', async () => {
    const { send, meal, day } = await setup();
    await meal(-10, 1800);
    const w = await body(await send('GET', `/v1/insights/weekly?end=${day(-8)}`));
    expect(w.range).toEqual({ from: '2026-10-07', to: '2026-10-13' });
    expect(w.summary.daysLogged).toBe(1);
    expect((await send('GET', '/v1/insights/weekly?end=2026-02-30')).status).toBe(422);
    expect((await send('GET', '/v1/insights/weekly?end=soon')).status).toBe(422);
  });
  it('does not count other people’s meals', async () => {
    const { t, send } = await setup();
    const other = await signUp(t);
    await t.request(
      `/v1/diary/entries/${newId()}`,
      jsonInit(
        'PUT',
        {
          loggedAt: T0,
          localDate: '2026-10-21',
          mealType: 'lunch',
          name: 'x',
          calories: 999,
          source: 'manual',
          clientUpdatedAt: T0,
        },
        other.accessToken,
      ),
    );
    expect((await body(await send('GET', '/v1/insights/weekly'))).summary.daysLogged).toBe(0);
    expect((await body(await send('GET', '/v1/insights/weekly'))).highlights).toEqual([
      'No meals were logged this week.',
    ]);
  });
  it('writes a short summary for Pro, from numbers only', async () => {
    const { send, meal, pro, ai } = await setup();
    await pro();
    await meal(0, 2100, { name: 'Secret recipe my mother made' });
    ai.textAnswer = 'You logged on one day and stayed near your goal.';
    const w = await body(await send('GET', '/v1/insights/weekly?narrative=true'));
    expect(w.narrative).toBe('You logged on one day and stayed near your goal.');
    expect(ai.textCalls).toHaveLength(1);
    const sent = ai.textCalls[0]!.user;
    expect(JSON.parse(sent)).toMatchObject({ range: { to: '2026-10-21' }, summary: { daysLogged: 1 } });
    expect(sent).not.toContain('Secret recipe');
    expect((await body(await send('GET', '/v1/entitlements'))).usage.aiText).toBe(1);
  });
  it('keeps the written summary for Pro', async () => {
    const { send } = await setup();
    const res = await send('GET', '/v1/insights/weekly?narrative=true');
    expect(res.status).toBe(402);
    expect((await body(res)).error.code).toBe('subscription_required');
  });
  it('still returns the numbers, and the allowance, when the AI service is down', async () => {
    const { send, meal, pro, ai } = await setup();
    await pro();
    await meal(0, 2100);
    ai.fail = true;
    const res = await send('GET', '/v1/insights/weekly?narrative=true');
    expect(res.status).toBe(200);
    const w = await body(res);
    expect(w.narrative).toBeNull();
    expect(w.summary.daysLogged).toBe(1);
    expect((await body(await send('GET', '/v1/entitlements'))).usage.aiText).toBe(0);
  });
});
