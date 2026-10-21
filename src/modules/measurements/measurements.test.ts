import { describe, expect, it } from 'vitest';
import { newId } from '../../core/ids';
import { T0, body, jsonInit, makeApp, signUp } from '../../../test/helpers/app';
import { MEASUREMENT_TYPES, RANGES } from './measurements.schemas';

const TODAY = '2026-10-21';
const m = (over: Record<string, unknown> = {}) => ({
  loggedAt: T0,
  localDate: TODAY,
  type: 'waist',
  value: 84.2,
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

describe('measurements', () => {
  it('stores a reading with its unit', async () => {
    const { send } = await setup();
    const id = newId();
    const { record } = await body(await send('PUT', `/v1/measurements/${id}`, m({ note: 'after lunch' })));
    expect(record).toMatchObject({ id, type: 'waist', value: 84.2, unit: 'cm', note: 'after lunch' });
    const fat = await body(
      await send('PUT', `/v1/measurements/${newId()}`, m({ type: 'body_fat', value: 18.5 })),
    );
    expect(fat.record).toMatchObject({ type: 'body_fat', value: 18.5, unit: '%' });
  });
  it('rounds to one decimal', async () => {
    const { send } = await setup();
    expect(
      (await body(await send('PUT', `/v1/measurements/${newId()}`, m({ value: 84.26 })))).record.value,
    ).toBe(84.3);
  });
  it('refuses impossible values for each kind', async () => {
    const { send } = await setup();
    for (const type of MEASUREMENT_TYPES) {
      const r = RANGES[type];
      for (const value of [r.min - 0.5, r.max + 1, 0, -5]) {
        const res = await send('PUT', `/v1/measurements/${newId()}`, m({ type, value }));
        expect(res.status, `${type} ${value}`).toBe(422);
      }
      expect((await send('PUT', `/v1/measurements/${newId()}`, m({ type, value: r.min }))).status).toBe(200);
      expect((await send('PUT', `/v1/measurements/${newId()}`, m({ type, value: r.max }))).status).toBe(200);
    }
    expect((await send('PUT', `/v1/measurements/${newId()}`, m({ type: 'ears' }))).status).toBe(422);
  });
  it('lists a range, optionally of one kind, oldest first', async () => {
    const { send } = await setup();
    await send('PUT', `/v1/measurements/${newId()}`, m({ type: 'waist', value: 85 }));
    await send('PUT', `/v1/measurements/${newId()}`, m({ type: 'hips', value: 100 }));
    await send('PUT', `/v1/measurements/${newId()}`, m({ type: 'waist', value: 84, loggedAt: T0 + 1000 }));
    const all = await body(await send('GET', `/v1/measurements?from=${TODAY}&to=${TODAY}`));
    expect(all.items).toHaveLength(3);
    const waists = await body(await send('GET', `/v1/measurements?from=${TODAY}&to=${TODAY}&type=waist`));
    expect(waists.items.map((i: any) => i.value)).toEqual([85, 84]);
    expect((await send('GET', `/v1/measurements?from=${TODAY}&to=${TODAY}&type=ears`)).status).toBe(422);
    expect((await send('GET', '/v1/measurements?from=2020-01-01&to=2026-01-01')).status).toBe(422);
    expect((await send('GET', '/v1/measurements?from=2026-10-22&to=2026-10-21')).status).toBe(422);
  });
  it('is last-edit-wins, deletable and private', async () => {
    const { t, send } = await setup();
    const id = newId();
    await send('PUT', `/v1/measurements/${id}`, m());
    expect(
      (await body(await send('PUT', `/v1/measurements/${id}`, m({ value: 80, clientUpdatedAt: T0 + 500 }))))
        .record.value,
    ).toBe(80);
    expect(
      (await body(await send('PUT', `/v1/measurements/${id}`, m({ value: 99, clientUpdatedAt: T0 + 5 }))))
        .applied,
    ).toBe(false);
    const other = await signUp(t);
    expect((await send('PUT', `/v1/measurements/${id}`, m(), other.accessToken)).status).toBe(409);
    expect((await send('DELETE', `/v1/measurements/${id}`)).status).toBe(204);
    expect((await body(await send('GET', `/v1/measurements?from=${TODAY}&to=${TODAY}`))).items).toEqual([]);
  });
});
