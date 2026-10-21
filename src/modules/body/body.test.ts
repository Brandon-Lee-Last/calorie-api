import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { newId } from '../../core/ids';
import { DAY, MINUTE } from '../../core/time';
import { T0, authed, body, jsonInit, makeApp, signUp } from '../../../test/helpers/app';

const TODAY = '2026-10-21';

async function setup() {
  const t = makeApp();
  const s = await signUp(t);
  const send = (method: string, path: string, data?: unknown) =>
    t.request(path, jsonInit(method, data, s.accessToken));
  const weight = (over: Record<string, unknown> = {}) => ({
    loggedAt: T0,
    localDate: TODAY,
    weightKg: 80,
    clientUpdatedAt: T0,
    ...over,
  });
  return { t, s, send, weight };
}

describe('weight', () => {
  it('stores an entry and returns it', async () => {
    const { send, weight } = await setup();
    const id = newId();
    const res = await send('PUT', `/v1/weight/${id}`, weight({ weightKg: 79.4, note: 'morning' }));
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({
      applied: true,
      record: { id, weightKg: 79.4, note: 'morning', localDate: TODAY, deletedAt: null, clientUpdatedAt: T0 },
    });
  });
  it('is idempotent: sending the same thing twice leaves one row', async () => {
    const { send, weight, s } = await setup();
    const id = newId();
    await send('PUT', `/v1/weight/${id}`, weight());
    expect((await body(await send('PUT', `/v1/weight/${id}`, weight()))).applied).toBe(true);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM weight_logs WHERE user_id = ?')
      .bind(s.userId)
      .first<{ n: number }>();
    expect(n!.n).toBe(1);
  });
  it('the later edit wins and an older one is reported as stale with the server version', async () => {
    const { send, weight } = await setup();
    const id = newId();
    await send('PUT', `/v1/weight/${id}`, weight({ weightKg: 80, clientUpdatedAt: T0 }));
    const newer = await body(
      await send('PUT', `/v1/weight/${id}`, weight({ weightKg: 78, clientUpdatedAt: T0 + 1000 })),
    );
    expect(newer).toMatchObject({ applied: true, record: { weightKg: 78 } });
    const older = await body(
      await send('PUT', `/v1/weight/${id}`, weight({ weightKg: 99, clientUpdatedAt: T0 + 500 })),
    );
    expect(older).toMatchObject({ applied: false, record: { weightKg: 78, clientUpdatedAt: T0 + 1000 } });
  });
  it('does not let a device with a runaway clock win forever', async () => {
    const { send, weight } = await setup();
    const id = newId();
    const res = await body(
      await send('PUT', `/v1/weight/${id}`, weight({ clientUpdatedAt: T0 + 3650 * DAY })),
    );
    expect(res.record.clientUpdatedAt).toBe(T0 + 5 * MINUTE);
  });
  it('keeps the profile weight, and the goals, in step with the newest log', async () => {
    const { send, weight, t, s } = await setup();
    await send('PATCH', '/v1/me/profile', {
      sex: 'male',
      birthYear: 1996,
      heightCm: 180,
      weightKg: 90,
      activityLevel: 'moderate',
    });
    const before = (await body(await t.request('/v1/me/profile', { headers: authed(s.accessToken) }))).goals
      .calories;
    const a = newId();
    const b = newId();
    await send('PUT', `/v1/weight/${a}`, weight({ weightKg: 80 }));
    await send(
      'PUT',
      `/v1/weight/${b}`,
      weight({ weightKg: 85, loggedAt: T0 - DAY, localDate: '2026-10-20' }),
    );
    const profile = await body(await t.request('/v1/me/profile', { headers: authed(s.accessToken) }));
    expect(profile.weightKg).toBe(80); // the one dated today, not the last one sent
    expect(profile.goals.calories).toBeLessThan(before);
    await send('DELETE', `/v1/weight/${a}`);
    expect((await body(await t.request('/v1/me/profile', { headers: authed(s.accessToken) }))).weightKg).toBe(
      85,
    );
  });
  it('deleting hides the entry, is repeatable, and can be undone by a later edit', async () => {
    const { send, weight } = await setup();
    const id = newId();
    await send('PUT', `/v1/weight/${id}`, weight());
    expect((await send('DELETE', `/v1/weight/${id}`)).status).toBe(204);
    expect((await send('DELETE', `/v1/weight/${id}`)).status).toBe(204);
    expect((await send('DELETE', `/v1/weight/${newId()}`)).status).toBe(204);
    expect((await body(await send('GET', `/v1/weight?from=${TODAY}&to=${TODAY}`))).items).toEqual([]);
    {
      const stale = await body(await send('PUT', `/v1/weight/${id}`, weight({ clientUpdatedAt: T0 - 1000 })));
      expect(stale.applied).toBe(false);
      expect(stale.record.deletedAt).not.toBeNull();
      const undone = await body(
        await send('PUT', `/v1/weight/${id}`, weight({ clientUpdatedAt: T0 + 60_000 })),
      );
      expect(undone).toMatchObject({ applied: true, record: { deletedAt: null } });
    }
  });
  it('lists a date range oldest first and caps its length', async () => {
    const { send, weight } = await setup();
    await send(
      'PUT',
      `/v1/weight/${newId()}`,
      weight({ weightKg: 81, loggedAt: T0 - DAY, localDate: '2026-10-20' }),
    );
    await send('PUT', `/v1/weight/${newId()}`, weight({ weightKg: 80 }));
    const list = await body(await send('GET', '/v1/weight?from=2026-10-01&to=2026-10-31'));
    expect(list.items.map((i: { weightKg: number }) => i.weightKg)).toEqual([81, 80]);
    expect((await send('GET', '/v1/weight?from=2025-01-01&to=2026-10-31')).status).toBe(422);
    expect((await send('GET', '/v1/weight?from=2026-10-31&to=2026-10-01')).status).toBe(422);
    expect((await send('GET', '/v1/weight?from=2026-02-30&to=2026-03-01')).status).toBe(422);
  });
  it('rejects nonsense', async () => {
    const { send, weight } = await setup();
    const id = newId();
    for (const bad of [
      { weightKg: 5 },
      { weightKg: 900 },
      { weightKg: 'heavy' },
      { localDate: '2026-10-25' },
      { localDate: 'yesterday' },
      { loggedAt: T0 + 3 * DAY, localDate: '2026-10-24' },
      { loggedAt: 1000, localDate: '1970-01-01' },
      { note: 'x'.repeat(501) },
    ]) {
      expect((await send('PUT', `/v1/weight/${id}`, weight(bad))).status).toBe(422);
    }
    expect((await send('PUT', '/v1/weight/not-an-id', weight())).status).toBe(422);
  });
  it('requires sign-in and keeps users apart', async () => {
    const { t, send, weight } = await setup();
    const id = newId();
    await send('PUT', `/v1/weight/${id}`, weight());
    expect((await t.request(`/v1/weight/${id}`, jsonInit('PUT', weight()))).status).toBe(401);
    const other = await signUp(t);
    const asOther = (method: string, path: string, data?: unknown) =>
      t.request(path, jsonInit(method, data, other.accessToken));
    expect((await asOther('PUT', `/v1/weight/${id}`, weight())).status).toBe(409); // cannot take over somebody else's id
    expect((await asOther('DELETE', `/v1/weight/${id}`)).status).toBe(204); // and deleting it does nothing
    expect((await body(await asOther('GET', `/v1/weight?from=${TODAY}&to=${TODAY}`))).items).toEqual([]);
    expect((await body(await send('GET', `/v1/weight?from=${TODAY}&to=${TODAY}`))).items).toHaveLength(1);
  });
});

describe('water', () => {
  const water = (over: Record<string, unknown> = {}) => ({
    loggedAt: T0,
    localDate: TODAY,
    ml: 250,
    clientUpdatedAt: T0,
    ...over,
  });

  it('adds up per day and skips deleted entries', async () => {
    const { send } = await setup();
    const a = newId();
    await send('PUT', `/v1/water/${a}`, water({ ml: 250 }));
    await send('PUT', `/v1/water/${newId()}`, water({ ml: 500, loggedAt: T0 + 1000 }));
    await send(
      'PUT',
      `/v1/water/${newId()}`,
      water({ ml: 300, loggedAt: T0 - DAY, localDate: '2026-10-20' }),
    );
    let list = await body(await send('GET', '/v1/water?from=2026-10-20&to=2026-10-21'));
    expect(list.totalsByDate).toEqual({ '2026-10-20': 300, '2026-10-21': 750 });
    await send('DELETE', `/v1/water/${a}`);
    list = await body(await send('GET', '/v1/water?from=2026-10-20&to=2026-10-21'));
    expect(list.totalsByDate['2026-10-21']).toBe(500);
    expect(list.items).toHaveLength(2);
  });
  it('can be corrected and is idempotent', async () => {
    const { send } = await setup();
    const id = newId();
    await send('PUT', `/v1/water/${id}`, water());
    const res = await body(await send('PUT', `/v1/water/${id}`, water({ ml: 330, clientUpdatedAt: T0 + 1 })));
    expect(res).toMatchObject({ applied: true, record: { ml: 330 } });
  });
  it('rejects zero, huge and fractional amounts', async () => {
    const { send } = await setup();
    for (const ml of [0, -5, 6000, 250.5])
      expect((await send('PUT', `/v1/water/${newId()}`, water({ ml }))).status).toBe(422);
  });
  it('keeps users apart', async () => {
    const { t, send } = await setup();
    const id = newId();
    await send('PUT', `/v1/water/${id}`, water());
    const other = await signUp(t);
    expect((await t.request(`/v1/water/${id}`, jsonInit('PUT', water(), other.accessToken))).status).toBe(
      409,
    );
    expect(
      (
        await body(
          await t.request(`/v1/water?from=${TODAY}&to=${TODAY}`, { headers: authed(other.accessToken) }),
        )
      ).items,
    ).toEqual([]);
  });
});
