import { describe, expect, it } from 'vitest';
import { newId } from '../../core/ids';
import { DAY } from '../../core/time';
import { T0, authed, body, jsonInit, makeApp, signUp } from '../../../test/helpers/app';

const TODAY = '2026-10-21';
const entryData = (over: Record<string, unknown> = {}) => ({
  loggedAt: T0,
  localDate: TODAY,
  mealType: 'lunch',
  name: 'Toasted sandwich',
  calories: 420,
  source: 'manual',
  clientUpdatedAt: T0,
  ...over,
}); // fmt: skip
const weightData = (over: Record<string, unknown> = {}) => ({
  loggedAt: T0,
  localDate: TODAY,
  weightKg: 80,
  clientUpdatedAt: T0,
  ...over,
});
const waterData = (over: Record<string, unknown> = {}) => ({
  loggedAt: T0,
  localDate: TODAY,
  ml: 250,
  clientUpdatedAt: T0,
  ...over,
});
const foodData = (over: Record<string, unknown> = {}) => ({
  name: 'Rusk',
  calories100g: 430,
  protein100g: 9,
  carb100g: 70,
  fat100g: 12,
  clientUpdatedAt: T0,
  ...over,
});

async function setup() {
  const t = makeApp();
  const s = await signUp(t);
  const send = (method: string, path: string, data?: unknown, token = s.accessToken) =>
    t.request(path, jsonInit(method, data, token));
  const pull = async (since = 0, limit = 200, token = s.accessToken) =>
    body(await send('GET', `/v1/sync/pull?since=${since}&limit=${limit}`, undefined, token));
  const push = async (ops: unknown[], token = s.accessToken) =>
    body(await send('POST', '/v1/sync/push', { ops }, token));
  return { t, s, send, pull, push };
}

describe('sync pull', () => {
  it('starts empty', async () => {
    const { pull } = await setup();
    expect(await pull()).toEqual({ changes: [], rev: 0, hasMore: false });
  });
  it('returns every kind of record, oldest change first, and where to continue from', async () => {
    const { send, pull } = await setup();
    await send('PUT', `/v1/diary/entries/${newId()}`, entryData());
    await send('PUT', `/v1/weight/${newId()}`, weightData());
    await send('PUT', `/v1/water/${newId()}`, waterData());
    await send('PUT', `/v1/foods/${newId()}`, foodData());
    const r = await pull();
    expect(r.changes.map((c: { type: string }) => c.type)).toEqual([
      'diary_entry',
      'weight',
      'water',
      'food',
    ]);
    expect(r.changes.map((c: { record: { rev: number } }) => c.record.rev)).toEqual([1, 2, 3, 4]);
    expect(r).toMatchObject({ rev: 4, hasMore: false });
    expect(await pull(4)).toEqual({ changes: [], rev: 4, hasMore: false });
  });
  it('only returns what changed after the revision given', async () => {
    const { send, pull } = await setup();
    const a = newId();
    await send('PUT', `/v1/diary/entries/${a}`, entryData());
    const first = await pull();
    await send('PUT', `/v1/diary/entries/${a}`, entryData({ calories: 300, clientUpdatedAt: T0 + 1 }));
    await send('PUT', `/v1/water/${newId()}`, waterData());
    const next = await pull(first.rev);
    expect(next.changes.map((c: { type: string }) => c.type)).toEqual(['diary_entry', 'water']);
    expect(next.changes[0].record.calories).toBe(300);
  });
  it('delivers deletions as records with deletedAt set', async () => {
    const { send, pull } = await setup();
    const id = newId();
    await send('PUT', `/v1/weight/${id}`, weightData());
    const before = await pull();
    await send('DELETE', `/v1/weight/${id}`);
    const after = await pull(before.rev);
    expect(after.changes).toHaveLength(1);
    expect(after.changes[0].record).toMatchObject({ id, deletedAt: T0 });
  });
  it('pages through a long history without skipping or repeating anything', async () => {
    const { send, pull } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const id = newId();
      ids.push(id);
      await send(
        'PUT',
        i % 2 ? `/v1/water/${id}` : `/v1/diary/entries/${id}`,
        i % 2 ? waterData() : entryData({ name: `meal ${i}` }),
      );
    }
    const seen: string[] = [];
    let since = 0;
    let pages = 0;
    for (;;) {
      const r = await pull(since, 3);
      seen.push(...r.changes.map((c: { record: { id: string } }) => c.record.id));
      since = r.rev;
      pages++;
      if (!r.hasMore) break;
    }
    expect(seen).toEqual(ids);
    expect(pages).toBe(3);
    expect(since).toBe(7);
  });
  it('shows an edited record once, at its latest revision', async () => {
    const { send, pull } = await setup();
    const id = newId();
    await send('PUT', `/v1/diary/entries/${id}`, entryData());
    await send('PUT', `/v1/diary/entries/${id}`, entryData({ calories: 1, clientUpdatedAt: T0 + 1 }));
    const r = await pull();
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].record).toMatchObject({ calories: 1, rev: 2 });
  });
  it('tells other devices when a photo is attached', async () => {
    const { t, s, send, pull } = await setup();
    const id = newId();
    await send('PUT', `/v1/diary/entries/${id}`, entryData());
    const first = await pull();
    await t.request(`/v1/diary/entries/${id}/photo`, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg', ...authed(s.accessToken) },
      body: Uint8Array.from([0xff, 0xd8, 0xff, 1, 2]),
    });
    const next = await pull(first.rev);
    expect(next.changes[0].record).toMatchObject({ id, hasPhoto: true });
  });
  it('never mixes users', async () => {
    const { t, send, pull } = await setup();
    await send('PUT', `/v1/diary/entries/${newId()}`, entryData());
    const other = await signUp(t);
    expect(await pull(0, 200, other.accessToken)).toEqual({ changes: [], rev: 0, hasMore: false });
  });
  it('validates its arguments and needs sign-in', async () => {
    const { t, send } = await setup();
    expect((await send('GET', '/v1/sync/pull?since=-1')).status).toBe(422);
    expect((await send('GET', '/v1/sync/pull?limit=0')).status).toBe(422);
    expect((await send('GET', '/v1/sync/pull?limit=501')).status).toBe(422);
    expect((await t.request('/v1/sync/pull')).status).toBe(401);
  });
});

describe('sync push', () => {
  it('applies a mixed batch and reports each op', async () => {
    const { push, pull } = await setup();
    const ids = { e: newId(), w: newId(), a: newId(), f: newId() };
    const { results } = await push([
      { type: 'diary_entry', id: ids.e, op: 'upsert', data: entryData() },
      { type: 'weight', id: ids.w, op: 'upsert', data: weightData() },
      { type: 'water', id: ids.a, op: 'upsert', data: waterData() },
      { type: 'food', id: ids.f, op: 'upsert', data: foodData() },
    ]);
    expect(results.map((r: { status: string }) => r.status)).toEqual([
      'applied',
      'applied',
      'applied',
      'applied',
    ]);
    expect(results[0].record).toMatchObject({ id: ids.e, name: 'Toasted sandwich' });
    expect((await pull()).changes).toHaveLength(4);
  });
  it('reports stale ops with the version that won, and is safe to repeat', async () => {
    const { push } = await setup();
    const id = newId();
    await push([
      { type: 'diary_entry', id, op: 'upsert', data: entryData({ calories: 500, clientUpdatedAt: T0 + 10 }) },
    ]);
    const { results } = await push([
      { type: 'diary_entry', id, op: 'upsert', data: entryData({ calories: 100, clientUpdatedAt: T0 + 1 }) },
      { type: 'diary_entry', id, op: 'upsert', data: entryData({ calories: 500, clientUpdatedAt: T0 + 10 }) },
    ]);
    expect(results[0]).toMatchObject({ status: 'stale', record: { calories: 500 } });
    expect(results[1].status).toBe('applied');
  });
  it('does not let one bad op stop the rest', async () => {
    const { push } = await setup();
    const good = newId();
    const { results } = await push([
      { type: 'diary_entry', id: newId(), op: 'upsert', data: entryData({ calories: -4 }) },
      { type: 'diary_entry', id: newId(), op: 'upsert' },
      { type: 'weight', id: good, op: 'upsert', data: weightData() },
      { type: 'water', id: newId(), op: 'upsert', data: waterData({ localDate: '2030-01-01' }) },
    ]);
    expect(results.map((r: { status: string }) => r.status)).toEqual(['error', 'error', 'applied', 'error']);
    expect(results[0].error).toMatchObject({ code: 'validation_failed' });
    expect(results[0].error.details[0].path).toBe('calories');
    expect(results[3].error.code).toBe('validation_failed');
  });
  it('applies deletions, and reports repeats as no-ops', async () => {
    const { push, pull } = await setup();
    const id = newId();
    await push([{ type: 'water', id, op: 'upsert', data: waterData() }]);
    const del = await push([
      { type: 'water', id, op: 'delete' },
      { type: 'water', id, op: 'delete' },
      { type: 'food', id: newId(), op: 'delete' },
    ]);
    expect(del.results.map((r: { status: string }) => r.status)).toEqual(['applied', 'noop', 'noop']);
    expect((await pull()).changes[0].record.deletedAt).toBe(T0);
  });
  it('respects the time of an offline delete versus a newer edit', async () => {
    const { push } = await setup();
    const id = newId();
    await push([{ type: 'weight', id, op: 'upsert', data: weightData({ clientUpdatedAt: T0 + 100 }) }]);
    const { results } = await push([{ type: 'weight', id, op: 'delete', clientUpdatedAt: T0 + 50 }]);
    expect(results[0].status).toBe('stale');
  });
  it('rejects ids that belong to somebody else, per op', async () => {
    const { t, push, send } = await setup();
    const id = newId();
    await send('PUT', `/v1/diary/entries/${id}`, entryData());
    const other = await signUp(t);
    const { results } = await push(
      [{ type: 'diary_entry', id, op: 'upsert', data: entryData() }],
      other.accessToken,
    );
    expect(results[0]).toMatchObject({ status: 'error', error: { code: 'conflict' } });
  });
  it('limits batch size and shape', async () => {
    const { send } = await setup();
    expect((await send('POST', '/v1/sync/push', { ops: [] })).status).toBe(422);
    const tooMany = Array.from({ length: 51 }, () => ({
      type: 'water',
      id: newId(),
      op: 'upsert',
      data: waterData(),
    }));
    expect((await send('POST', '/v1/sync/push', { ops: tooMany })).status).toBe(422);
    expect(
      (await send('POST', '/v1/sync/push', { ops: [{ type: 'banana', id: newId(), op: 'upsert' }] })).status,
    ).toBe(422);
    expect(
      (await send('POST', '/v1/sync/push', { ops: [{ type: 'water', id: 'bad id', op: 'upsert' }] })).status,
    ).toBe(422);
  });
});

describe('two devices', () => {
  it('converge on the same state', async () => {
    const { send, pull, push } = await setup();
    // Phone A logs breakfast and a weight offline, then pushes.
    const meal = newId();
    const weight = newId();
    await push([
      { type: 'diary_entry', id: meal, op: 'upsert', data: entryData({ name: 'Oats', calories: 300 }) },
      { type: 'weight', id: weight, op: 'upsert', data: weightData({ weightKg: 81 }) },
    ]);
    // Tablet B pulls everything.
    const b1 = await pull();
    expect(b1.changes).toHaveLength(2);
    // B corrects the meal and A, still on the old copy, edits the same meal earlier in time.
    await send(
      'PUT',
      `/v1/diary/entries/${meal}`,
      entryData({ name: 'Oats', calories: 350, clientUpdatedAt: T0 + 2000 }),
    );
    const stale = await push([
      {
        type: 'diary_entry',
        id: meal,
        op: 'upsert',
        data: entryData({ name: 'Oats', calories: 280, clientUpdatedAt: T0 + 1000 }),
      },
    ]);
    expect(stale.results[0]).toMatchObject({ status: 'stale', record: { calories: 350 } });
    // A deletes the weight; B hears about it.
    await push([{ type: 'weight', id: weight, op: 'delete', clientUpdatedAt: T0 + 3000 }]);
    const b2 = await pull(b1.rev);
    const byId = Object.fromEntries(
      b2.changes.map((c: { record: { id: string } }) => [c.record.id, c.record]),
    );
    expect(byId[meal].calories).toBe(350);
    expect(byId[weight].deletedAt).not.toBeNull();
    // A fresh device sees only the surviving truth: one live meal and the weight as a tombstone.
    const fresh = await pull();
    expect(
      fresh.changes.filter((c: { record: { deletedAt: number | null } }) => c.record.deletedAt === null),
    ).toHaveLength(1);
    void DAY;
  });
});

describe('the newer record types', () => {
  const recipeData = (over: Record<string, unknown> = {}) => ({
    name: 'Chicken and rice',
    servings: 2,
    ingredients: [{ name: 'Rice', calories: 260, proteinG: 5, carbG: 56, fatG: 1 }],
    clientUpdatedAt: T0,
    ...over,
  });
  const activityData = (over: Record<string, unknown> = {}) => ({
    loggedAt: T0,
    localDate: TODAY,
    kind: 'running',
    durationMin: 30,
    clientUpdatedAt: T0,
    ...over,
  });
  const measurementData = (over: Record<string, unknown> = {}) => ({
    loggedAt: T0,
    localDate: TODAY,
    type: 'waist',
    value: 84,
    clientUpdatedAt: T0,
    ...over,
  });
  const progressData = (over: Record<string, unknown> = {}) => ({
    loggedAt: T0,
    localDate: TODAY,
    pose: 'front',
    clientUpdatedAt: T0,
    ...over,
  });

  it('are pulled alongside the rest, in revision order', async () => {
    const { send, pull } = await setup();
    await send('PUT', `/v1/recipes/${newId()}`, recipeData());
    await send('PUT', `/v1/activity/${newId()}`, activityData());
    await send('PUT', `/v1/measurements/${newId()}`, measurementData());
    await send('PUT', `/v1/progress/${newId()}`, progressData());
    const r = await pull();
    expect(r.changes.map((c: { type: string }) => c.type)).toEqual([
      'recipe',
      'activity',
      'measurement',
      'progress_photo',
    ]);
    expect(r.changes[0].record.perServing.calories).toBe(130);
    expect(r.changes[1].record.caloriesEstimated).toBe(true);
    expect(r).toMatchObject({ rev: 4, hasMore: false });
  });
  it('can be pushed from a second device, and a delete comes back as a tombstone', async () => {
    const { push, pull } = await setup();
    const ids = [newId(), newId(), newId(), newId()];
    const res = await push([
      { type: 'recipe', id: ids[0], op: 'upsert', data: recipeData() },
      { type: 'activity', id: ids[1], op: 'upsert', data: activityData() },
      { type: 'measurement', id: ids[2], op: 'upsert', data: measurementData() },
      { type: 'progress_photo', id: ids[3], op: 'upsert', data: progressData() },
    ]);
    expect(res.results.map((r: { status: string }) => r.status)).toEqual([
      'applied',
      'applied',
      'applied',
      'applied',
    ]);
    const del = await push([
      { type: 'recipe', id: ids[0], op: 'delete', clientUpdatedAt: T0 + 10 },
      { type: 'activity', id: ids[1], op: 'delete', clientUpdatedAt: T0 + 10 },
      { type: 'measurement', id: ids[2], op: 'delete', clientUpdatedAt: T0 + 10 },
      { type: 'progress_photo', id: ids[3], op: 'delete', clientUpdatedAt: T0 + 10 },
    ]);
    expect(del.results.map((r: { status: string }) => r.status)).toEqual([
      'applied',
      'applied',
      'applied',
      'applied',
    ]);
    const changes = (await pull(4)).changes;
    expect(changes).toHaveLength(4);
    expect(changes.every((c: { record: { deletedAt: number | null } }) => c.record.deletedAt !== null)).toBe(
      true,
    );
  });
  it('report a bad record without stopping the others', async () => {
    const { push } = await setup();
    const res = await push([
      { type: 'recipe', id: newId(), op: 'upsert', data: recipeData({ servings: 0 }) },
      { type: 'activity', id: newId(), op: 'upsert', data: activityData({ durationMin: undefined }) },
      { type: 'measurement', id: newId(), op: 'upsert', data: measurementData({ value: 9999 }) },
      { type: 'progress_photo', id: newId(), op: 'upsert', data: progressData({ pose: 'x' }) },
      { type: 'measurement', id: newId(), op: 'upsert', data: measurementData() },
    ]);
    expect(res.results.map((r: { status: string }) => r.status)).toEqual([
      'error',
      'error',
      'error',
      'error',
      'applied',
    ]);
    expect(res.results[0].error.code).toBe('validation_failed');
  });
  it('respect the recipe limit even when pushed through sync', async () => {
    const { push } = await setup();
    const ops = Array.from({ length: 11 }, (_, i) => ({
      type: 'recipe',
      id: newId(),
      op: 'upsert',
      data: recipeData({ name: `R${i}` }),
    }));
    const res = await push(ops.slice(0, 10));
    expect(res.results.every((r: { status: string }) => r.status === 'applied')).toBe(true);
    const more = await push(ops.slice(10));
    expect(more.results[0]).toMatchObject({ status: 'error', error: { code: 'quota_exceeded' } });
  });
});
