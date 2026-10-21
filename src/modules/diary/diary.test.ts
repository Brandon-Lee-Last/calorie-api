import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { newId } from '../../core/ids';
import { DAY } from '../../core/time';
import { T0, authed, body, jsonInit, makeApp, signUp } from '../../../test/helpers/app';

const TODAY = '2026-10-21';

async function setup() {
  const t = makeApp();
  const s = await signUp(t);
  const send = (method: string, path: string, data?: unknown) =>
    t.request(path, jsonInit(method, data, s.accessToken));
  const entry = (over: Record<string, unknown> = {}) => ({
    loggedAt: T0,
    localDate: TODAY,
    mealType: 'lunch',
    name: 'Chicken wrap',
    calories: 520,
    proteinG: 32,
    carbG: 48,
    fatG: 22,
    source: 'manual',
    clientUpdatedAt: T0,
    ...over,
  }); // fmt: skip
  const put = (id: string, over: Record<string, unknown> = {}) =>
    send('PUT', `/v1/diary/entries/${id}`, entry(over));
  const photo = (id: string, bytes: Uint8Array, type = 'image/jpeg', token = s.accessToken) =>
    t.request(`/v1/diary/entries/${id}/photo`, {
      method: 'PUT',
      headers: { 'content-type': type, ...authed(token) },
      body: bytes,
    });
  return { t, s, send, entry, put, photo };
}

const jpeg = (n = 64) =>
  Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: n }, (_, i) => i % 251)]);
const png = () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe('diary entries', () => {
  it('logs a meal and reads it back by date', async () => {
    const { send, put } = await setup();
    const id = newId();
    const res = await put(id, { servings: 1.5, fiberG: 4, note: 'with hummus' });
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({
      applied: true,
      record: {
        id,
        name: 'Chicken wrap',
        mealType: 'lunch',
        calories: 520,
        proteinG: 32,
        servings: 1.5,
        fiberG: 4,
        hasPhoto: false,
        deletedAt: null,
        rev: 1,
      },
    });
    const list = await body(await send('GET', `/v1/diary/entries?from=${TODAY}&to=${TODAY}`));
    expect(list.items).toHaveLength(1);
    expect(list.items[0].note).toBe('with hummus');
  });
  it('defaults macros to zero and keeps optional fields null', async () => {
    const { send, entry } = await setup();
    const { proteinG, carbG, fatG, ...bare } = entry();
    (void proteinG, carbG, fatG);
    const res = await body(await send('PUT', `/v1/diary/entries/${newId()}`, bare));
    expect(res.record).toMatchObject({
      proteinG: 0,
      carbG: 0,
      fatG: 0,
      fiberG: null,
      foodId: null,
      scanId: null,
      note: null,
    });
  });
  it('is idempotent and resolves edits by client time', async () => {
    const { put, s } = await setup();
    const id = newId();
    await put(id);
    await put(id);
    const edited = await body(await put(id, { calories: 480, clientUpdatedAt: T0 + 10 }));
    expect(edited).toMatchObject({ applied: true, record: { calories: 480 } });
    const stale = await body(await put(id, { calories: 999, clientUpdatedAt: T0 + 5 }));
    expect(stale).toMatchObject({ applied: false, record: { calories: 480 } });
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM diary_entries WHERE user_id = ?')
      .bind(s.userId)
      .first<{ n: number }>();
    expect(rows!.n).toBe(1);
  });
  it('gives every write a higher revision than the one before', async () => {
    const { put } = await setup();
    const revs: number[] = [];
    for (let i = 0; i < 4; i++) revs.push((await body(await put(newId()))).record.rev);
    expect(revs).toEqual([1, 2, 3, 4]);
  });
  it('deleting removes it from lists and totals', async () => {
    const { put, send } = await setup();
    const id = newId();
    await put(id);
    expect((await send('DELETE', `/v1/diary/entries/${id}`)).status).toBe(204);
    expect((await send('DELETE', `/v1/diary/entries/${id}`)).status).toBe(204);
    expect((await body(await send('GET', `/v1/diary/entries?from=${TODAY}&to=${TODAY}`))).items).toEqual([]);
    expect((await body(await send('GET', `/v1/diary/summary?from=${TODAY}&to=${TODAY}`))).days).toEqual([]);
  });
  it('rejects bad entries and says where', async () => {
    const { send, entry } = await setup();
    const cases: [Record<string, unknown>, string][] = [
      [{ calories: -1 }, 'calories'],
      [{ calories: 50000 }, 'calories'],
      [{ name: '   ' }, 'name'],
      [{ mealType: 'brunch' }, 'mealType'],
      [{ source: 'telepathy' }, 'source'],
      [{ servings: 0 }, 'servings'],
      [{ proteinG: -3 }, 'proteinG'],
      [{ foodId: 'nope' }, 'foodId'],
      [{ localDate: '2026-10-25' }, 'localDate'],
      [{ loggedAt: T0 + 5 * DAY, localDate: '2026-10-26' }, 'loggedAt'],
    ]; // fmt: skip
    for (const [over, path] of cases) {
      const res = await send('PUT', `/v1/diary/entries/${newId()}`, entry(over));
      expect(res.status, JSON.stringify(over)).toBe(422);
      expect((await body(res)).error.details.map((d: { path: string }) => d.path)).toContain(path);
    }
  });
  it('keeps users apart', async () => {
    const { t, put, send } = await setup();
    const id = newId();
    await put(id);
    const other = await signUp(t);
    const asOther = (m: string, p: string, d?: unknown) => t.request(p, jsonInit(m, d, other.accessToken));
    expect(
      (
        await asOther('PUT', `/v1/diary/entries/${id}`, {
          loggedAt: T0,
          localDate: TODAY,
          mealType: 'lunch',
          name: 'x',
          calories: 1,
          source: 'manual',
          clientUpdatedAt: T0,
        })
      ).status,
    ).toBe(409);
    expect((await asOther('DELETE', `/v1/diary/entries/${id}`)).status).toBe(204);
    expect((await body(await asOther('GET', `/v1/diary/entries?from=${TODAY}&to=${TODAY}`))).items).toEqual(
      [],
    );
    expect((await body(await send('GET', `/v1/diary/entries?from=${TODAY}&to=${TODAY}`))).items).toHaveLength(
      1,
    );
    expect((await t.request(`/v1/diary/entries?from=${TODAY}&to=${TODAY}`)).status).toBe(401);
  });
  it('limits how much history one request can ask for', async () => {
    const { send } = await setup();
    expect((await send('GET', '/v1/diary/entries?from=2026-01-01&to=2026-10-21')).status).toBe(422);
    expect((await send('GET', '/v1/diary/summary?from=2024-01-01&to=2026-10-21')).status).toBe(422);
    expect((await send('GET', '/v1/diary/entries?from=2026-09-01&to=2026-10-21')).status).toBe(200);
  });
});

describe('diary summary', () => {
  it('adds up each day, ignores deleted entries and includes water-only days', async () => {
    const { put, send } = await setup();
    await put(newId(), { calories: 500, proteinG: 30, carbG: 50, fatG: 20, fiberG: 5, sodiumMg: 400 });
    await put(newId(), {
      calories: 250.5,
      proteinG: 10,
      carbG: 30,
      fatG: 5,
      mealType: 'snack',
      loggedAt: T0 + 1000,
    });
    const gone = newId();
    await put(gone, { calories: 9999 });
    await send('DELETE', `/v1/diary/entries/${gone}`);
    await put(newId(), { calories: 700, localDate: '2026-10-20', loggedAt: T0 - DAY });
    await send('PUT', `/v1/water/${newId()}`, {
      loggedAt: T0,
      localDate: TODAY,
      ml: 500,
      clientUpdatedAt: T0,
    });
    await send('PUT', `/v1/water/${newId()}`, {
      loggedAt: T0 - 2 * DAY,
      localDate: '2026-10-19',
      ml: 300,
      clientUpdatedAt: T0,
    });
    const { days } = await body(await send('GET', '/v1/diary/summary?from=2026-10-18&to=2026-10-21'));
    expect(days).toEqual([
      {
        localDate: '2026-10-19',
        entries: 0,
        calories: 0,
        proteinG: 0,
        carbG: 0,
        fatG: 0,
        fiberG: 0,
        sugarG: 0,
        sodiumMg: 0,
        waterMl: 300,
      },
      {
        localDate: '2026-10-20',
        entries: 1,
        calories: 700,
        proteinG: 32,
        carbG: 48,
        fatG: 22,
        fiberG: 0,
        sugarG: 0,
        sodiumMg: 0,
        waterMl: 0,
      },
      {
        localDate: TODAY,
        entries: 2,
        calories: 750.5,
        proteinG: 40,
        carbG: 80,
        fatG: 25,
        fiberG: 5,
        sugarG: 0,
        sodiumMg: 400,
        waterMl: 500,
      },
    ]); // fmt: skip
  });
});

describe('recent foods', () => {
  it('lists each food once, newest first, with how often it was logged', async () => {
    const { put, send } = await setup();
    await put(newId(), { name: 'Oats', calories: 300, loggedAt: T0 - 3 * DAY, localDate: '2026-10-18' });
    await put(newId(), { name: 'oats', calories: 320, loggedAt: T0 - DAY, localDate: '2026-10-20' });
    await put(newId(), { name: 'Banana', calories: 100, loggedAt: T0 - 2 * DAY, localDate: '2026-10-19' });
    const old = newId();
    await put(old, { name: 'Ancient toast', loggedAt: T0 - 90 * DAY, localDate: '2026-07-23' });
    const deleted = newId();
    await put(deleted, { name: 'Deleted thing' });
    await send('DELETE', `/v1/diary/entries/${deleted}`);
    const { items } = await body(await send('GET', '/v1/diary/recent'));
    expect(items.map((i: { name: string }) => i.name)).toEqual(['oats', 'Banana']);
    expect(items[0]).toMatchObject({ calories: 320, timesLogged: 2 });
    expect((await body(await send('GET', '/v1/diary/recent?limit=1'))).items).toHaveLength(1);
    expect((await send('GET', '/v1/diary/recent?limit=0')).status).toBe(422);
  });
});

describe('meal photos', () => {
  it('stores, serves, replaces and removes a photo', async () => {
    const { put, photo, send, s } = await setup();
    const id = newId();
    await put(id);
    const bytes = jpeg();
    const up = await photo(id, bytes);
    expect(up.status).toBe(200);
    expect(await body(up)).toMatchObject({ hasPhoto: true, rev: 2 });

    const got = await send('GET', `/v1/diary/entries/${id}/photo`);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/jpeg');
    expect(got.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);

    // replacing a jpeg with a png removes the old object
    await photo(id, png(), 'image/png');
    expect(await env.MEDIA.head(`users/${s.userId}/meals/${id}.jpg`)).toBeNull();
    expect(await env.MEDIA.head(`users/${s.userId}/meals/${id}.png`)).not.toBeNull();

    expect((await send('DELETE', `/v1/diary/entries/${id}/photo`)).status).toBe(204);
    expect((await send('GET', `/v1/diary/entries/${id}/photo`)).status).toBe(404);
    expect(await env.MEDIA.head(`users/${s.userId}/meals/${id}.png`)).toBeNull();
    expect((await send('DELETE', `/v1/diary/entries/${id}/photo`)).status).toBe(204);
  });
  it('is removed from storage when the entry is deleted', async () => {
    const { put, photo, send, s } = await setup();
    const id = newId();
    await put(id);
    await photo(id, jpeg());
    await send('DELETE', `/v1/diary/entries/${id}`);
    expect(await env.MEDIA.head(`users/${s.userId}/meals/${id}.jpg`)).toBeNull();
  });
  it('only accepts real images of the declared type, within the size limit', async () => {
    const { put, photo } = await setup();
    const id = newId();
    await put(id);
    expect((await photo(id, jpeg(), 'application/pdf')).status).toBe(400);
    expect((await photo(id, jpeg(), 'image/png')).status).toBe(400); // jpeg bytes, png claim
    expect(
      (await photo(id, new TextEncoder().encode('<script>alert(1)</script>'), 'image/jpeg')).status,
    ).toBe(400);
    expect((await photo(id, new Uint8Array(0))).status).toBe(400);
    const big = jpeg(3 * 1024 * 1024 + 100);
    const res = await photo(id, big);
    expect(res.status).toBe(413);
    expect((await body(res)).error.code).toBe('payload_too_large');
    const huge = await photo(id, jpeg(5 * 1024 * 1024));
    expect(huge.status).toBe(413);
  });
  it('needs a live entry, and other people cannot see it', async () => {
    const { t, put, photo, send } = await setup();
    expect((await photo(newId(), jpeg())).status).toBe(404);
    const id = newId();
    await put(id);
    await photo(id, jpeg());
    const other = await signUp(t);
    expect(
      (await t.request(`/v1/diary/entries/${id}/photo`, { headers: authed(other.accessToken) })).status,
    ).toBe(404);
    expect((await photo(id, jpeg(), 'image/jpeg', other.accessToken)).status).toBe(404);
    expect((await send('GET', `/v1/diary/entries/${id}/photo`)).status).toBe(200);
  });
});
