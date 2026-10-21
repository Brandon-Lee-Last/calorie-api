import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { adminClient } from '../../test/helpers/content';
import { T0, body, jsonInit, makeApp, signUp } from '../../test/helpers/app';
import { newId } from '../core/ids';
import { toBase64Url } from '../core/crypto';

const TODAY = '2026-10-21';
const ATTACKS = [
  "'; DROP TABLE users; --",
  "' OR '1'='1",
  "x' UNION SELECT id, user_id, 1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1 FROM foods --",
  '"; DELETE FROM foods; --',
  "Robert'); DROP TABLE diary_entries;--",
  '%',
  '_',
  '\\',
  "') OR 1=1 --",
];

async function tablesAndCounts() {
  const tables = (
    await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name",
    ).all<{ name: string }>()
  ).results.map((r) => r.name);
  const counts: Record<string, number> = {};
  for (const t of tables)
    counts[t] = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n;
  return { tables, counts };
}

async function setup() {
  const t = makeApp();
  const a = await signUp(t);
  const b = await signUp(t);
  const as = (s: typeof a) => (method: string, path: string, data?: unknown) =>
    t.request(path, jsonInit(method, data, s.accessToken));
  return { t, a, b, sendA: as(a), sendB: as(b) };
}

describe('SQL injection', () => {
  it('in searches finds nothing it should not, and leaks nobody else’s foods', async () => {
    const { sendA, sendB } = await setup();
    await sendB('PUT', `/v1/foods/${newId()}`, {
      name: 'Secret rice of B',
      calories100g: 1,
      protein100g: 0,
      carb100g: 0,
      fat100g: 0,
      clientUpdatedAt: T0,
    });
    const before = await tablesAndCounts();
    for (const attack of ATTACKS) {
      const res = await sendA('GET', `/v1/foods/search?q=${encodeURIComponent(attack + ' rice')}`);
      expect(res.status, attack).toBeLessThan(500);
      if (res.status === 200)
        expect((await body(res)).items.map((i: any) => i.name)).not.toContain('Secret rice of B');
    }
    // a lone wildcard is not "match everything"
    const wild = await sendA('GET', '/v1/foods/search?q=%25%25');
    expect([200, 422]).toContain(wild.status);
    if (wild.status === 200) expect((await body(wild)).items).toEqual([]);
    expect(await tablesAndCounts()).toEqual(before);
  });
  it('in stored text is kept as plain text and does nothing', async () => {
    const { sendA } = await setup();
    const before = (await tablesAndCounts()).tables;
    for (const [i, attack] of ATTACKS.entries()) {
      const id = newId();
      const put = await sendA('PUT', `/v1/diary/entries/${id}`, {
        loggedAt: T0,
        localDate: TODAY,
        mealType: 'lunch',
        name: attack.slice(0, 190) || 'x',
        calories: 100,
        source: 'manual',
        note: attack,
        clientUpdatedAt: T0 + i,
      });
      expect(put.status, attack).toBe(200);
      const got = (await body(await sendA('GET', `/v1/diary/entries?from=${TODAY}&to=${TODAY}`))).items.find(
        (e: any) => e.id === id,
      );
      expect(got.note).toBe(attack);
    }
    await sendA('PATCH', '/v1/me', { displayName: ATTACKS[4] });
    expect((await body(await sendA('GET', '/v1/me'))).displayName).toBe(ATTACKS[4]);
    expect((await tablesAndCounts()).tables).toEqual(before);
  });
  it('in pagination cursors is treated as data, not as SQL', async () => {
    const { sendA } = await setup();
    await sendA('PUT', `/v1/recipes/${newId()}`, {
      name: 'Pap',
      servings: 1,
      ingredients: [{ name: 'Maize', calories: 100 }],
      clientUpdatedAt: T0,
    });
    const evil = toBase64Url(
      new TextEncoder().encode(JSON.stringify({ n: "' OR 1=1 --", id: "x' OR '1'='1" })),
    );
    const res = await sendA('GET', `/v1/recipes?cursor=${evil}`);
    expect(res.status).toBe(200);
    expect((await body(res)).items.length).toBeLessThanOrEqual(1);
    const evilAudit = toBase64Url(new TextEncoder().encode(JSON.stringify({ id: "' OR 1=1 --" })));
    expect(
      (await adminClient(makeApp()).call('GET', `/v1/admin/audit?cursor=${evilAudit}`)).status,
    ).toBeLessThan(500);
  });
  it('in path ids, barcodes and dates is refused or finds nothing', async () => {
    const { sendA, a } = await setup();
    for (const attack of ATTACKS) {
      const enc = encodeURIComponent(attack);
      for (const path of [
        `/v1/foods/${enc}`,
        `/v1/foods/barcode/${enc}`,
        `/v1/diary/entries?from=${enc}&to=${enc}`,
        `/v1/weight?from=${enc}&to=${enc}`,
        `/v1/scans/${enc}`,
        `/v1/recipes/${enc}`,
        `/v1/foods/dish/${enc}`,
      ]) {
        const res = await sendA('GET', path);
        expect(res.status, `${path}`).toBeLessThan(500);
        expect(res.status, `${path}`).toBeGreaterThanOrEqual(400);
      }
    }
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?')
        .bind(a.userId)
        .first<{ n: number }>())!.n,
    ).toBe(1);
  });
  it('in the sign-in fields cannot get anyone in', async () => {
    const t = makeApp();
    for (const attack of ATTACKS) {
      expect(
        (await t.request('/v1/auth/email/start', jsonInit('POST', { email: `${attack}@example.com` })))
          .status,
      ).toBeLessThan(500);
      expect(
        (await t.request('/v1/auth/email/verify', jsonInit('POST', { email: `a@example.com`, code: attack })))
          .status,
      ).toBe(422);
      expect(
        (await t.request('/v1/auth/refresh', jsonInit('POST', { refreshToken: attack.padEnd(30, 'x') })))
          .status,
      ).toBe(401);
      expect([401, 501]).toContain(
        (await t.request('/v1/auth/google', jsonInit('POST', { idToken: attack.padEnd(30, 'x') }))).status,
      ); // 501: Google sign-in is not set up in tests
      expect((await t.request('/v1/me', jsonInit('GET', undefined, attack))).status).toBe(401);
      expect((await t.request('/v1/admin/settings', { headers: { 'x-admin-key': attack } })).status).toBe(
        401,
      );
    }
  });
  it('through the catalogue import ends up as plain text', async () => {
    const t = makeApp();
    const admin = adminClient(t);
    await env.DB.exec('DELETE FROM foods WHERE user_id IS NULL');
    const res = await body(
      await admin.call('POST', '/v1/admin/foods/import', {
        foods: ATTACKS.map((a, i) => ({
          source: 'curated',
          externalId: `inj:${i}`,
          name: a.slice(0, 190) || 'x',
          brand: a.slice(0, 90),
          calories100g: 100,
          protein100g: 1,
          carb100g: 1,
          fat100g: 1,
          aliases: [a.slice(0, 70)],
        })),
      }),
    );
    expect(res.created).toBe(ATTACKS.length);
    const row = await env.DB.prepare("SELECT name FROM foods WHERE external_id = 'inj:0'").first<{
      name: string;
    }>();
    expect(row!.name).toBe(ATTACKS[0]);
  });
});

describe('one person reaching for another’s data', () => {
  it('gets nothing from any per-person record type', async () => {
    const { sendA, sendB } = await setup();
    const id = () => newId();
    const mine = {
      diary: [
        id(),
        '/v1/diary/entries',
        {
          loggedAt: T0,
          localDate: TODAY,
          mealType: 'lunch',
          name: 'A',
          calories: 1,
          source: 'manual',
          clientUpdatedAt: T0,
        },
      ],
      weight: [id(), '/v1/weight', { loggedAt: T0, localDate: TODAY, weightKg: 80, clientUpdatedAt: T0 }],
      water: [id(), '/v1/water', { loggedAt: T0, localDate: TODAY, ml: 250, clientUpdatedAt: T0 }],
      food: [
        id(),
        '/v1/foods',
        { name: 'Rusk', calories100g: 1, protein100g: 0, carb100g: 0, fat100g: 0, clientUpdatedAt: T0 },
      ],
      recipe: [
        id(),
        '/v1/recipes',
        { name: 'R', servings: 1, ingredients: [{ name: 'x', calories: 1 }], clientUpdatedAt: T0 },
      ],
      activity: [
        id(),
        '/v1/activity',
        { loggedAt: T0, localDate: TODAY, kind: 'walking', durationMin: 10, clientUpdatedAt: T0 },
      ],
      measurement: [
        id(),
        '/v1/measurements',
        { loggedAt: T0, localDate: TODAY, type: 'waist', value: 80, clientUpdatedAt: T0 },
      ],
      progress: [
        id(),
        '/v1/progress',
        { loggedAt: T0, localDate: TODAY, pose: 'front', clientUpdatedAt: T0 },
      ],
    } as const;
    for (const [name, [rid, base, data]] of Object.entries(mine)) {
      expect((await sendA('PUT', `${base}/${rid}`, data)).status, `A creates ${name}`).toBe(200);
      // B cannot take over the same id, change it, or delete it
      expect(
        (await sendB('PUT', `${base}/${rid}`, { ...data, clientUpdatedAt: T0 + 99999 })).status,
        `B overwrites ${name}`,
      ).toBe(409);
      await sendB('DELETE', `${base}/${rid}`);
    }
    // A's records are all still there and unchanged
    const check = async (path: string, key = 'items') => (await body(await sendA('GET', path)))[key];
    expect(await check(`/v1/diary/entries?from=${TODAY}&to=${TODAY}`)).toHaveLength(1);
    expect(await check(`/v1/weight?from=${TODAY}&to=${TODAY}`)).toHaveLength(1);
    expect(await check(`/v1/water?from=${TODAY}&to=${TODAY}`)).toHaveLength(1);
    expect(await check('/v1/recipes')).toHaveLength(1);
    expect(await check(`/v1/activity?from=${TODAY}&to=${TODAY}`)).toHaveLength(1);
    expect(await check(`/v1/measurements?from=${TODAY}&to=${TODAY}`)).toHaveLength(1);
    expect(await check(`/v1/progress?from=${TODAY}&to=${TODAY}`)).toHaveLength(1);
    // and B sees none of it, by id, by list, or through sync
    for (const [rid, base] of Object.values(mine)) {
      const got = await sendB('GET', `${base}/${rid}`);
      expect([404, 405], `${base}`).toContain(got.status);
    }
    expect((await body(await sendB('GET', '/v1/recipes'))).items).toEqual([]);
    expect((await body(await sendB('GET', '/v1/sync/pull?since=0'))).changes).toEqual([]);
  });
});
