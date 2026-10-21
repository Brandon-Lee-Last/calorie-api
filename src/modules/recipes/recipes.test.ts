import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { newId } from '../../core/ids';
import { T0, body, jsonInit, linkAccount, makeApp, signUp } from '../../../test/helpers/app';
import { PLANS } from '../../config/plans';
import { MAX_INGREDIENTS } from './recipes.schemas';
import { sumIngredients } from './recipes.service';

const ing = (over: Record<string, unknown> = {}) => ({
  name: 'Rice',
  quantityG: 200,
  calories: 260,
  proteinG: 5.4,
  carbG: 56.4,
  fatG: 0.6,
  ...over,
});
const recipe = (over: Record<string, unknown> = {}) => ({
  name: 'Chicken and rice',
  servings: 2,
  ingredients: [
    ing(),
    ing({ name: 'Chicken breast', quantityG: 250, calories: 412, proteinG: 77, carbG: 0, fatG: 9 }),
  ],
  instructions: 'Cook the rice. Grill the chicken.',
  prepMinutes: 30,
  clientUpdatedAt: T0,
  ...over,
});

async function setup() {
  const t = makeApp();
  const s = await signUp(t);
  await linkAccount(s.userId);
  const send = (method: string, path: string, data?: unknown, token = s.accessToken) =>
    t.request(path, jsonInit(method, data, token));
  return { t, s, send };
}

describe('recipes', () => {
  it('stores a recipe and works out totals and per-serving figures', async () => {
    const { send } = await setup();
    const id = newId();
    const res = await send('PUT', `/v1/recipes/${id}`, recipe());
    expect(res.status).toBe(200);
    const { applied, record } = await body(res);
    expect(applied).toBe(true);
    expect(record).toMatchObject({
      id,
      name: 'Chicken and rice',
      servings: 2,
      totals: { calories: 672, proteinG: 82.4, carbG: 56.4, fatG: 9.6 },
      perServing: { calories: 336, proteinG: 41.2, carbG: 28.2, fatG: 4.8 },
      prepMinutes: 30,
      deletedAt: null,
    });
    expect(record.ingredients).toHaveLength(2);
    expect(record.ingredients[0]).toMatchObject({ name: 'Rice', quantityG: 200, calories: 260 });
  });
  it('is idempotent and last-edit-wins', async () => {
    const { send } = await setup();
    const id = newId();
    await send('PUT', `/v1/recipes/${id}`, recipe());
    expect((await body(await send('PUT', `/v1/recipes/${id}`, recipe()))).applied).toBe(true);
    const newer = await body(
      await send('PUT', `/v1/recipes/${id}`, recipe({ name: 'Newer', clientUpdatedAt: T0 + 5000 })),
    );
    expect(newer.record.name).toBe('Newer');
    const older = await body(
      await send('PUT', `/v1/recipes/${id}`, recipe({ name: 'Older', clientUpdatedAt: T0 + 100 })),
    );
    expect(older).toMatchObject({ applied: false, record: { name: 'Newer' } });
    expect((await body(await send('GET', '/v1/recipes'))).items).toHaveLength(1);
  });
  it('validates the recipe', async () => {
    const { send } = await setup();
    const put = (r: unknown) => send('PUT', `/v1/recipes/${newId()}`, r);
    for (const bad of [
      recipe({ name: '' }),
      recipe({ servings: 0 }),
      recipe({ servings: 101 }),
      recipe({ ingredients: [] }),
      recipe({ ingredients: Array.from({ length: MAX_INGREDIENTS + 1 }, () => ing()) }),
      recipe({ ingredients: [ing({ calories: -1 })] }),
      recipe({ ingredients: [ing({ calories: 99999 })] }),
      recipe({ ingredients: [ing({ name: '' })] }),
      recipe({ instructions: 'x'.repeat(5001) }),
      recipe({ prepMinutes: -5 }),
    ])
      expect((await put(bad)).status).toBe(422);
    expect((await put(recipe({ ingredients: [ing({ foodId: 'not an id' })] }))).status).toBe(422);
  });
  it('reads one back, lists A to Z in pages, and 404s on a missing or deleted one', async () => {
    const { send } = await setup();
    const ids: string[] = [];
    for (const name of ['Pap', 'Bobotie', 'Curry', 'Amasi']) {
      const id = newId();
      ids.push(id);
      await send('PUT', `/v1/recipes/${id}`, recipe({ name }));
    }
    expect((await body(await send('GET', `/v1/recipes/${ids[0]}`))).name).toBe('Pap');
    expect((await send('GET', `/v1/recipes/${newId()}`)).status).toBe(404);
    const first = await body(await send('GET', '/v1/recipes?limit=3'));
    expect(first.items.map((r: any) => r.name)).toEqual(['Amasi', 'Bobotie', 'Curry']);
    const second = await body(await send('GET', `/v1/recipes?limit=3&cursor=${first.nextCursor}`));
    expect(second.items.map((r: any) => r.name)).toEqual(['Pap']);
    expect(second.nextCursor).toBeNull();
    expect((await send('GET', '/v1/recipes?cursor=garbage')).status).toBe(400);
    expect((await send('DELETE', `/v1/recipes/${ids[0]}`)).status).toBe(204);
    expect((await send('DELETE', `/v1/recipes/${ids[0]}`)).status).toBe(204);
    expect((await send('GET', `/v1/recipes/${ids[0]}`)).status).toBe(404);
    expect((await body(await send('GET', '/v1/recipes'))).items).toHaveLength(3);
  });
  it('keeps one person’s recipes away from another’s', async () => {
    const { t, send } = await setup();
    const id = newId();
    await send('PUT', `/v1/recipes/${id}`, recipe());
    const other = await signUp(t);
    expect((await send('GET', `/v1/recipes/${id}`, undefined, other.accessToken)).status).toBe(404);
    expect((await send('PUT', `/v1/recipes/${id}`, recipe(), other.accessToken)).status).toBe(409);
    expect((await body(await send('GET', '/v1/recipes', undefined, other.accessToken))).items).toEqual([]);
  });
  it('limits free accounts, but never blocks editing an existing recipe, and Pro is unlimited', async () => {
    const { send } = await setup();
    const limit = PLANS.free.limits.recipes;
    const ids: string[] = [];
    for (let i = 0; i < limit; i++) {
      ids.push(newId());
      expect((await send('PUT', `/v1/recipes/${ids[i]}`, recipe({ name: `R${i}` }))).status).toBe(200);
    }
    const blocked = await send('PUT', `/v1/recipes/${newId()}`, recipe());
    expect(blocked.status).toBe(429);
    expect((await body(blocked)).error).toMatchObject({
      code: 'quota_exceeded',
      details: { key: 'recipes', limit },
    });
    expect(
      (await send('PUT', `/v1/recipes/${ids[0]}`, recipe({ name: 'Edited', clientUpdatedAt: T0 + 1 })))
        .status,
    ).toBe(200);
    await send('DELETE', `/v1/recipes/${ids[1]}`);
    expect((await send('PUT', `/v1/recipes/${newId()}`, recipe())).status).toBe(200); // freed a place
    await send('POST', '/v1/subscription/simulate', { scenario: 'subscribe' });
    expect((await send('PUT', `/v1/recipes/${newId()}`, recipe())).status).toBe(200);
  });
  it('survives a damaged ingredient column without breaking the list', async () => {
    const { s, send } = await setup();
    const id = newId();
    await send('PUT', `/v1/recipes/${id}`, recipe());
    await env.DB.prepare('UPDATE recipes SET ingredients = ? WHERE id = ?').bind('{not json', id).run();
    const r = await body(await send('GET', '/v1/recipes'));
    expect(r.items[0]).toMatchObject({ ingredients: [], totals: { calories: 0 } });
    void s;
  });
  it('needs sign-in', async () => {
    const { t } = await setup();
    expect((await t.request('/v1/recipes')).status).toBe(401);
  });
});

describe('sumIngredients', () => {
  it('adds up and rounds', () => {
    expect(sumIngredients([])).toEqual({ calories: 0, proteinG: 0, carbG: 0, fatG: 0 });
    expect(sumIngredients([ing(), ing()] as never)).toEqual({
      calories: 520,
      proteinG: 10.8,
      carbG: 112.8,
      fatG: 1.2,
    });
  });
});
