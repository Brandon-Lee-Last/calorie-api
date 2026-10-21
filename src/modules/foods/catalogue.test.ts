import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminClient } from '../../../test/helpers/content';
import { body, jsonInit, makeApp, signUp } from '../../../test/helpers/app';
import { energyGap } from './catalogue.service';
import { MAX_IMPORT } from './catalogue.schemas';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM foods WHERE user_id IS NULL');
});

const rice = {
  source: 'usda',
  externalId: 'fdc:168878',
  name: 'Rice, white, long-grain, cooked',
  calories100g: 130,
  protein100g: 2.7,
  carb100g: 28.2,
  fat100g: 0.3,
  fiber100g: 0.4,
  sugar100g: 0.1,
  sodiumMg100g: 1,
  servingG: 158,
  servingLabel: '1 cup',
};
const bunny = {
  source: 'curated',
  externalId: 'safoods:bunny-chow-mutton',
  name: 'Bunny chow, mutton curry',
  calories100g: 150,
  protein100g: 7,
  carb100g: 17,
  fat100g: 6,
  dishId: 'bunny_chow',
  aliases: ['bunny', 'Kota (Durban)'],
};

function setup() {
  const t = makeApp();
  const admin = adminClient(t);
  const imp = (foods: unknown[], dryRun = false) =>
    admin.call('POST', '/v1/admin/foods/import', { foods, dryRun });
  return { t, admin, imp };
}

describe('POST /admin/foods/import', () => {
  it('needs the admin key', async () => {
    const t = makeApp();
    expect((await t.request('/v1/admin/foods/import', jsonInit('POST', { foods: [rice] }))).status).toBe(401);
  });
  it('adds foods, which people can then find, and updates them in place the second time', async () => {
    const { t, imp } = setup();
    const first = await body(await imp([rice, bunny]));
    expect(first).toMatchObject({ created: 2, updated: 0, rejected: [], dryRun: false });
    const s = await signUp(t);
    const search = async (q: string) =>
      (
        await body(
          await t.request(
            `/v1/foods/search?q=${encodeURIComponent(q)}`,
            jsonInit('GET', undefined, s.accessToken),
          ),
        )
      ).items;
    const found = await search('white rice');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      source: 'usda',
      isOwn: false,
      calories100g: 130,
      servingG: 158,
      perServing: { calories: 205.4 },
      dishId: null,
    });

    const again = await body(await imp([{ ...rice, calories100g: 131 }]));
    expect(again).toMatchObject({ created: 0, updated: 1 });
    expect((await search('white rice'))[0].calories100g).toBe(131);
    expect(await search('white rice')).toHaveLength(1);
  });
  it('finds a dish by its alternative names, with accents and case ignored', async () => {
    const { t, imp } = setup();
    await imp([bunny]);
    const s = await signUp(t);
    for (const q of ['kota', 'KOTA durban', 'bunny chow']) {
      const items = (
        await body(
          await t.request(
            `/v1/foods/search?q=${encodeURIComponent(q)}`,
            jsonInit('GET', undefined, s.accessToken),
          ),
        )
      ).items;
      expect(
        items.map((i: any) => i.name),
        q,
      ).toEqual(['Bunny chow, mutton curry']);
    }
  });
  it('links foods to a dish and lists them for it', async () => {
    const { t, imp } = setup();
    await imp([
      bunny,
      { ...bunny, externalId: 'safoods:bunny-chow-beans', name: 'Bunny chow, bean curry', calories100g: 140 },
      rice,
    ]);
    const s = await signUp(t);
    const res = await t.request('/v1/foods/dish/bunny_chow', jsonInit('GET', undefined, s.accessToken));
    expect((await body(res)).items.map((i: any) => i.name)).toEqual([
      'Bunny chow, bean curry',
      'Bunny chow, mutton curry',
    ]);
    expect(
      (await body(await t.request('/v1/foods/dish/vetkoek', jsonInit('GET', undefined, s.accessToken))))
        .items,
    ).toEqual([]);
    expect((await t.request('/v1/foods/dish/Bad-Id', jsonInit('GET', undefined, s.accessToken))).status).toBe(
      422,
    );
    expect((await t.request('/v1/foods/dish/bunny_chow')).status).toBe(401);
  });
  it('reports bad rows by position and still imports the good ones', async () => {
    const { imp } = setup();
    const res = await body(
      await imp([
        rice,
        { ...rice, externalId: 'fdc:1', calories100g: undefined },
        { ...rice, externalId: 'fdc:2', calories100g: 5000 },
        { ...rice, externalId: 'fdc:3', protein100g: 60, carb100g: 40, fat100g: 20 },
        { ...rice, externalId: 'fdc:4', barcode: '5449000000995' },
        { ...rice, externalId: 'fdc:5', source: 'made-up' },
        { ...rice, externalId: '' },
        'not an object',
        null,
        { ...rice },
      ]),
    );
    expect(res.created).toBe(1);
    expect(res.rejected.map((r: any) => r.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const reason = (i: number) => res.rejected.find((r: any) => r.index === i).reason as string;
    expect(reason(1)).toContain('calories100g');
    expect(reason(2)).toContain('calories100g');
    expect(reason(3)).toContain('more than 100 g');
    expect(reason(4)).toContain('check digit');
    expect(reason(5)).toContain('source');
    expect(reason(9)).toContain('listed twice');
    expect(res.rejected.find((r: any) => r.index === 1).externalId).toBe('fdc:1');
    expect(res.rejected.find((r: any) => r.index === 7).externalId).toBeNull();
  });
  it('never fills in a missing figure', async () => {
    const { imp } = setup();
    const res = await body(await imp([{ ...rice, protein100g: undefined }]));
    expect(res.created).toBe(0);
    expect(res.rejected[0].reason).toContain('protein100g');
  });
  it('refuses a barcode that already belongs to another catalogue food, inside the batch and across imports', async () => {
    const { imp } = setup();
    const withCode = { ...rice, barcode: '6001087000005' };
    // 6001087000005 is not a valid GTIN: use a valid one
    const valid = '4006381333931';
    const a = await body(await imp([{ ...rice, barcode: valid }]));
    expect(a.created).toBe(1);
    const b = await body(await imp([{ ...rice, externalId: 'fdc:other', barcode: valid }]));
    expect(b.created).toBe(0);
    expect(b.rejected[0].reason).toContain('already belongs to usda:fdc:168878');
    const c = await body(
      await imp([
        { ...rice, externalId: 'x1', barcode: '4012345678901' },
        { ...rice, externalId: 'x2', barcode: '4012345678901' },
      ]),
    );
    expect(c.created).toBe(1);
    expect(c.rejected[0].reason).toContain('already used by x1 in this import');
    // the same food re-imported with its own barcode is fine
    expect((await body(await imp([{ ...rice, barcode: valid, calories100g: 129 }]))).updated).toBe(1);
    void withCode;
  });
  it('warns, but still imports, when energy and macros disagree or sugar exceeds carbohydrate', async () => {
    const { imp } = setup();
    const res = await body(await imp([{ ...rice, externalId: 'odd', calories100g: 400, sugar100g: 40 }]));
    expect(res.created).toBe(1);
    expect(res.warnings.map((w: any) => w.message).join()).toContain('does not match the macros');
    expect(res.warnings.map((w: any) => w.message).join()).toContain('sugar is more than carbohydrate');
  });
  it('changes nothing on a dry run, and says what would happen', async () => {
    const { imp } = setup();
    await imp([rice]);
    const dry = await body(await imp([{ ...rice, calories100g: 99 }, bunny], true));
    expect(dry).toMatchObject({ created: 1, updated: 1, dryRun: true });
    const row = await env.DB.prepare(
      "SELECT calories_100g AS c FROM foods WHERE external_id = 'fdc:168878'",
    ).first<{ c: number }>();
    expect(row!.c).toBe(130);
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM foods WHERE user_id IS NULL').first<{ n: number }>())!
        .n,
    ).toBe(1);
  });
  it('limits one import to 100 foods and needs at least one', async () => {
    const { admin } = setup();
    const many = Array.from({ length: MAX_IMPORT + 1 }, (_, i) => ({ ...rice, externalId: `fdc:${i}` }));
    expect((await admin.call('POST', '/v1/admin/foods/import', { foods: many })).status).toBe(422);
    expect((await admin.call('POST', '/v1/admin/foods/import', { foods: [] })).status).toBe(422);
    const ok = many.slice(0, MAX_IMPORT);
    expect((await body(await admin.call('POST', '/v1/admin/foods/import', { foods: ok }))).created).toBe(
      MAX_IMPORT,
    );
  });
  it('rounds to one decimal and stores nothing it was not given', async () => {
    const { imp } = setup();
    await imp([
      {
        source: 'curated',
        externalId: 'min',
        name: 'Plain thing',
        calories100g: 100.04,
        protein100g: 1.26,
        carb100g: 2,
        fat100g: 3,
      },
    ]);
    const row = await env.DB.prepare("SELECT * FROM foods WHERE external_id = 'min'").first<any>();
    expect(row).toMatchObject({
      calories_100g: 100,
      protein_100g: 1.3,
      fiber_100g: null,
      sugar_100g: null,
      serving_g: null,
      dish_id: null,
      aliases_norm: null,
      user_id: null,
    });
  });
  it('only ever touches catalogue rows, never a person’s own foods', async () => {
    const { t, imp } = setup();
    const s = await signUp(t);
    const id = '01JABCDEFGHJKMNPQRSTVWXYZ0';
    await t.request(
      `/v1/foods/${id}`,
      jsonInit(
        'PUT',
        {
          name: 'Gran’s rice',
          calories100g: 1,
          protein100g: 0,
          carb100g: 0,
          fat100g: 0,
          clientUpdatedAt: 1_700_000_000_000,
        },
        s.accessToken,
      ),
    );
    await imp([rice]);
    const own = await body(await t.request(`/v1/foods/${id}`, jsonInit('GET', undefined, s.accessToken)));
    expect(own).toMatchObject({ name: 'Gran’s rice', calories100g: 1, isOwn: true });
  });
});

describe('DELETE /admin/foods/{id}', () => {
  it('removes a catalogue food and 404s on a repeat, or on someone’s own food', async () => {
    const { t, admin, imp } = setup();
    await imp([rice]);
    const row = await env.DB.prepare('SELECT id FROM foods WHERE user_id IS NULL').first<{ id: string }>();
    expect((await admin.call('DELETE', `/v1/admin/foods/${row!.id}`)).status).toBe(200);
    expect((await admin.call('DELETE', `/v1/admin/foods/${row!.id}`)).status).toBe(404);

    const s = await signUp(t);
    const mine = '01JABCDEFGHJKMNPQRSTVWXYZ1';
    await t.request(
      `/v1/foods/${mine}`,
      jsonInit(
        'PUT',
        {
          name: 'Mine',
          calories100g: 1,
          protein100g: 0,
          carb100g: 0,
          fat100g: 0,
          clientUpdatedAt: 1_700_000_000_000,
        },
        s.accessToken,
      ),
    );
    expect((await admin.call('DELETE', `/v1/admin/foods/${mine}`)).status).toBe(404);
    expect((await t.request(`/v1/foods/${mine}`, jsonInit('GET', undefined, s.accessToken))).status).toBe(
      200,
    );
    expect((await t.request(`/v1/admin/foods/${mine}`, { method: 'DELETE' })).status).toBe(401);
  });
});

describe('energyGap', () => {
  it('accepts ordinary foods and flags impossible ones', () => {
    expect(energyGap({ calories100g: 130, protein100g: 2.7, carb100g: 28.2, fat100g: 0.3 }).mismatch).toBe(
      false,
    );
    expect(energyGap({ calories100g: 884, protein100g: 0, carb100g: 0, fat100g: 100 }).mismatch).toBe(false);
    expect(energyGap({ calories100g: 400, protein100g: 2.7, carb100g: 28.2, fat100g: 0.3 }).mismatch).toBe(
      true,
    );
    expect(energyGap({ calories100g: 10, protein100g: 50, carb100g: 0, fat100g: 0 }).mismatch).toBe(false); // too small to judge
    expect(energyGap({ calories100g: 30, protein100g: 1, carb100g: 20, fat100g: 0 }).fromMacros).toBe(84);
  });
});
