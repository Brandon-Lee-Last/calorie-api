import { beforeEach, describe, expect, it } from 'vitest';
import { adminClient, resetContent } from '../../../test/helpers/content';
import { body, jsonInit, makeApp, signUp } from '../../../test/helpers/app';

beforeEach(resetContent);

const diet = (over: Record<string, unknown> = {}) => ({
  title: 'Balanced',
  summary: 'Everyday eating, the South African way.',
  tier: 'free',
  goals: ['lose', 'maintain', 'gain'],
  split: { breakfast: 0.25, lunch: 0.3, dinner: 0.3, snack: 0.15 },
  macros: { proteinPct: 20, carbPct: 50, fatPct: 30 },
  ...over,
}); // fmt: skip

const meal = (over: Record<string, unknown> = {}) => ({
  title: 'Oats with banana',
  slots: ['breakfast'],
  diets: ['balanced'],
  minutes: 5,
  ingredients: [
    { name: 'Rolled oats', grams: 50 },
    { name: 'Banana', grams: 100 },
  ],
  steps: ['Cook the oats with water.', 'Slice the banana on top.'],
  nutrition: { calories: 284, proteinG: 7.5, carbG: 56, fatG: 3.8 },
  ...over,
}); // fmt: skip

async function setup() {
  const t = makeApp();
  const admin = adminClient(t);
  const s = await signUp(t);
  const send = (method: string, path: string, data?: unknown) =>
    t.request(path, jsonInit(method, data, s.accessToken));
  const plans = async () => body(await send('GET', '/v1/meal-plans'));
  await admin.call('PUT', '/v1/admin/diets/balanced', diet());
  await admin.call(
    'PUT',
    '/v1/admin/diets/high-protein',
    diet({ title: 'High protein', tier: 'pro', position: 2, caution: null }),
  );
  return { t, admin, send, plans };
}

describe('meal plans', () => {
  it('serves diets in order and meals A to Z, locking Pro styles and Pro-only meals on a free account', async () => {
    const { admin, send, plans } = await setup();
    expect((await admin.call('PUT', '/v1/admin/meals/oats', meal())).status).toBe(200);
    await admin.call(
      'PUT',
      '/v1/admin/meals/eggs',
      meal({ title: 'Eggs on toast', diets: ['balanced', 'high-protein'] }),
    );
    await admin.call(
      'PUT',
      '/v1/admin/meals/steak',
      meal({ title: 'Steak and greens', slots: ['dinner'], diets: ['high-protein'] }),
    );

    const free = await plans();
    expect(free.diets.map((d: any) => [d.slug, d.locked, d.mealCount])).toEqual([
      ['balanced', false, 2],
      ['high-protein', true, 2],
    ]);
    expect(free.meals.map((m: any) => [m.slug, m.locked])).toEqual([
      ['eggs', false],
      ['oats', false],
      ['steak', true],
    ]);
    const steak = free.meals.find((m: any) => m.slug === 'steak');
    expect(steak.ingredients).toEqual([]);
    expect(steak.steps).toEqual([]);
    expect(steak.nutrition.calories).toBe(284);
    expect(free.updatedAt).toEqual(expect.any(Number));

    await send('POST', '/v1/subscription/simulate', { scenario: 'subscribe' });
    const pro = await plans();
    expect(pro.diets.every((d: any) => !d.locked)).toBe(true);
    expect(pro.meals.find((m: any) => m.slug === 'steak').ingredients).toHaveLength(2);
  });

  it('needs a signed-in account', async () => {
    const { t } = await setup();
    expect((await t.request('/v1/meal-plans')).status).toBe(401);
  });

  it('updates in place by slug', async () => {
    const { admin, plans } = await setup();
    await admin.call('PUT', '/v1/admin/meals/oats', meal());
    await admin.call('PUT', '/v1/admin/meals/oats', meal({ title: 'Oats, banana and cinnamon' }));
    expect((await plans()).meals.map((m: any) => m.title)).toEqual(['Oats, banana and cinnamon']);
  });

  it('refuses a meal in an unknown diet, numbers that do not add up, or a slot twice', async () => {
    const { admin } = await setup();
    const unknown = await admin.call('PUT', '/v1/admin/meals/x', meal({ diets: ['paleo'] }));
    expect(unknown.status).toBe(422);
    expect((await body(unknown)).error.message).toMatch(/paleo/);
    const typo = await admin.call(
      'PUT',
      '/v1/admin/meals/x',
      meal({ nutrition: { calories: 2840, proteinG: 7.5, carbG: 56, fatG: 3.8 } }),
    );
    expect(typo.status).toBe(422);
    expect((await admin.call('PUT', '/v1/admin/meals/x', meal({ slots: ['lunch', 'lunch'] }))).status).toBe(
      422,
    );
    expect((await admin.call('PUT', '/v1/admin/meals/Bad_Slug', meal())).status).toBe(422);
  });

  it('refuses diet shares or macros that do not add up', async () => {
    const { admin } = await setup();
    expect(
      (
        await admin.call(
          'PUT',
          '/v1/admin/diets/x',
          diet({ split: { breakfast: 0.5, lunch: 0.5, dinner: 0.5, snack: 0 } }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await admin.call(
          'PUT',
          '/v1/admin/diets/x',
          diet({ macros: { proteinPct: 50, carbPct: 50, fatPct: 30 } }),
        )
      ).status,
    ).toBe(422);
  });

  it('keeps a diet while meals use it, and deletes meals and unused diets', async () => {
    const { admin, plans } = await setup();
    await admin.call('PUT', '/v1/admin/meals/oats', meal());
    expect((await admin.call('DELETE', '/v1/admin/diets/balanced')).status).toBe(409);
    expect((await admin.call('DELETE', '/v1/admin/meals/oats')).status).toBe(204);
    expect((await admin.call('DELETE', '/v1/admin/diets/balanced')).status).toBe(204);
    expect(await body(await admin.call('GET', '/v1/admin/meal-plans'))).toEqual({
      diets: ['high-protein'],
      meals: [],
    });
    expect((await plans()).diets.map((d: any) => d.slug)).toEqual(['high-protein']);
  });

  it('is admin only to change', async () => {
    const { send } = await setup();
    expect((await send('PUT', '/v1/admin/meals/oats', meal())).status).toBe(401);
  });
});
