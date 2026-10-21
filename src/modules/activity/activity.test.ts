import { describe, expect, it } from 'vitest';
import { newId } from '../../core/ids';
import { T0, body, jsonInit, makeApp, signUp } from '../../../test/helpers/app';
import { DEFAULT_WEIGHT_KG, MET, estimateCalories } from '../../lib/activity';

const TODAY = '2026-10-21';
const run = (over: Record<string, unknown> = {}) => ({
  loggedAt: T0,
  localDate: TODAY,
  kind: 'running',
  durationMin: 30,
  clientUpdatedAt: T0,
  ...over,
});

async function setup() {
  const t = makeApp();
  const s = await signUp(t);
  const send = (method: string, path: string, data?: unknown, token = s.accessToken) =>
    t.request(path, jsonInit(method, data, token));
  return { t, s, send };
}

describe('estimateCalories', () => {
  it('is MET x weight x hours, and says nothing where it cannot', () => {
    expect(estimateCalories('running', 30, 70)).toBe(Math.round(MET.running! * 70 * 0.5));
    expect(estimateCalories('walking', 60, 80)).toBe(Math.round(3.5 * 80));
    expect(estimateCalories('running', 30, null)).toBe(Math.round(MET.running! * DEFAULT_WEIGHT_KG * 0.5));
    expect(estimateCalories('steps', 30, 70)).toBeNull();
    expect(estimateCalories('other', 30, 70)).toBeNull();
    expect(estimateCalories('running', null, 70)).toBeNull();
    expect(estimateCalories('running', 0, 70)).toBeNull();
  });
});

describe('activity', () => {
  it('estimates calories from the person’s weight and marks them as an estimate', async () => {
    const { send } = await setup();
    await send('PATCH', '/v1/me/profile', { weightKg: 80 });
    const id = newId();
    const { record } = await body(await send('PUT', `/v1/activity/${id}`, run()));
    expect(record).toMatchObject({
      kind: 'running',
      durationMin: 30,
      caloriesBurned: Math.round(MET.running! * 80 * 0.5),
      caloriesEstimated: true,
    });
  });
  it('uses a default weight when the profile has none', async () => {
    const { send } = await setup();
    const { record } = await body(
      await send('PUT', `/v1/activity/${newId()}`, run({ kind: 'cycling', durationMin: 60 })),
    );
    expect(record.caloriesBurned).toBe(Math.round(MET.cycling! * DEFAULT_WEIGHT_KG));
    expect(record.caloriesEstimated).toBe(true);
  });
  it('keeps the person’s own number exactly, and does not call it an estimate', async () => {
    const { send } = await setup();
    const { record } = await body(await send('PUT', `/v1/activity/${newId()}`, run({ caloriesBurned: 412 })));
    expect(record).toMatchObject({ caloriesBurned: 412, caloriesEstimated: false });
    const zero = await body(await send('PUT', `/v1/activity/${newId()}`, run({ caloriesBurned: 0 })));
    expect(zero.record).toMatchObject({ caloriesBurned: 0, caloriesEstimated: false });
  });
  it('stores step counts without inventing calories', async () => {
    const { send } = await setup();
    const { record } = await body(
      await send('PUT', `/v1/activity/${newId()}`, {
        loggedAt: T0,
        localDate: TODAY,
        kind: 'steps',
        steps: 8421,
        distanceKm: 6.1,
        clientUpdatedAt: T0,
      }),
    );
    expect(record).toMatchObject({
      kind: 'steps',
      steps: 8421,
      distanceKm: 6.1,
      durationMin: null,
      caloriesBurned: null,
      caloriesEstimated: false,
    });
  });
  it('gives no estimate for activities it cannot judge', async () => {
    const { send } = await setup();
    const { record } = await body(
      await send('PUT', `/v1/activity/${newId()}`, run({ kind: 'other', name: 'Rock climbing' })),
    );
    expect(record).toMatchObject({ name: 'Rock climbing', caloriesBurned: null, caloriesEstimated: false });
  });
  it('validates', async () => {
    const { send } = await setup();
    const put = (d: unknown) => send('PUT', `/v1/activity/${newId()}`, d);
    for (const bad of [
      run({ durationMin: undefined }),
      run({ durationMin: 0 }),
      run({ durationMin: 2000 }),
      run({ kind: 'steps', durationMin: undefined }),
      run({ kind: 'steps', steps: 0 }),
      run({ kind: 'steps', steps: 999999, durationMin: undefined }),
      run({ kind: 'teleporting' }),
      run({ caloriesBurned: -1 }),
      run({ caloriesBurned: 50000 }),
      run({ distanceKm: -3 }),
      run({ localDate: '2026-10-25' }), // does not match loggedAt
      run({ loggedAt: T0 + 5 * 86_400_000, localDate: '2026-10-26' }), // in the future
    ])
      expect((await put(bad)).status, JSON.stringify(bad)).toBe(422);
  });
  it('lists a range with daily totals, and limits the range', async () => {
    const { send } = await setup();
    await send('PUT', `/v1/activity/${newId()}`, run({ caloriesBurned: 300, durationMin: 30 }));
    await send('PUT', `/v1/activity/${newId()}`, run({ caloriesBurned: 200, durationMin: 20 }));
    await send('PUT', `/v1/activity/${newId()}`, {
      loggedAt: T0,
      localDate: TODAY,
      kind: 'steps',
      steps: 5000,
      clientUpdatedAt: T0,
    });
    const res = await body(await send('GET', `/v1/activity?from=${TODAY}&to=${TODAY}`));
    expect(res.items).toHaveLength(3);
    expect(res.totalsByDate[TODAY]).toEqual({ minutes: 50, caloriesBurned: 500, steps: 5000 });
    expect((await send('GET', '/v1/activity?from=2020-01-01&to=2026-01-01')).status).toBe(422);
    expect((await send('GET', '/v1/activity?from=2026-10-22&to=2026-10-21')).status).toBe(422);
  });
  it('is last-edit-wins, deletable, and private', async () => {
    const { t, send } = await setup();
    const id = newId();
    await send('PUT', `/v1/activity/${id}`, run());
    const newer = await body(
      await send('PUT', `/v1/activity/${id}`, run({ durationMin: 45, clientUpdatedAt: T0 + 1000 })),
    );
    expect(newer.record.durationMin).toBe(45);
    expect(
      (
        await body(
          await send('PUT', `/v1/activity/${id}`, run({ durationMin: 10, clientUpdatedAt: T0 + 10 })),
        )
      ).applied,
    ).toBe(false);
    const other = await signUp(t);
    expect((await send('PUT', `/v1/activity/${id}`, run(), other.accessToken)).status).toBe(409);
    expect((await send('DELETE', `/v1/activity/${id}`)).status).toBe(204);
    expect((await body(await send('GET', `/v1/activity?from=${TODAY}&to=${TODAY}`))).items).toEqual([]);
  });
});
