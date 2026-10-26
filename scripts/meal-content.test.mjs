// Checks the meal-plan content (content/meal-plans) and the scripts that load and verify it. Plain Node, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  mealBody,
  mealNutrition,
  planImport,
  planPrune,
  readJsonFolder,
  runImport,
} from './import-content.mjs';
import { checkIngredients, per100gOf } from './check-ingredients.mjs';

const root = fileURLToPath(new URL('../content/meal-plans', import.meta.url));
const table = JSON.parse(readFileSync(`${root}/ingredients.json`, 'utf8'));
const diets = readJsonFolder(`${root}/diets`).map((f) => f.data);
const meals = readJsonFolder(`${root}/meals`).map((f) => f.data);
const AISLES = ['produce', 'meat-fish', 'dairy-eggs', 'bakery-grains', 'pantry', 'frozen'];
const KINDS = ['plant', 'meat', 'fish', 'egg', 'dairy', 'honey'];

test('mealNutrition adds up each ingredient per 100 g, to whole kcal and tenths of a gram', () => {
  const t = {
    oats: { per100g: { kcal: 379, protein: 13.2, carb: 67.7, fat: 6.5, fibre: 10.1 } },
    milk: { per100g: { kcal: 50, protein: 3.3, carb: 4.8, fat: 2, fibre: 0 } },
  };
  assert.deepEqual(
    mealNutrition(
      [
        { id: 'oats', grams: 50 },
        { id: 'milk', grams: 200 },
      ],
      t,
    ),
    {
      calories: 290,
      proteinG: 13.2,
      carbG: 43.5,
      fatG: 7.3,
      fibreG: 5.1,
    },
  );
  assert.equal(
    mealNutrition([{ id: 'oats', grams: 50 }], {
      oats: { per100g: { kcal: 1, protein: 0, carb: 0, fat: 0 } },
    }).fibreG,
    null,
  );
  assert.throws(() => mealNutrition([{ id: 'nope', grams: 1 }], t), /unknown ingredient "nope"/);
  assert.throws(() => mealNutrition([{ id: 'oats', grams: 0 }], t), /grams above 0/);
});

test('every ingredient has a name, kind, aisle and figures, names its USDA food, and is used', () => {
  const used = new Set(meals.flatMap((m) => m.ingredients.map((i) => i.id)));
  for (const [id, ing] of Object.entries(table)) {
    assert.ok(ing.name, `${id}: name`);
    assert.ok(KINDS.includes(ing.kind), `${id}: kind ${ing.kind}`);
    assert.ok(AISLES.includes(ing.aisle), `${id}: aisle ${ing.aisle}`);
    for (const k of ['kcal', 'protein', 'carb', 'fat'])
      assert.equal(typeof ing.per100g[k], 'number', `${id}: ${k}`);
    assert.ok(
      ing.fdc || ing.usda || (ing.fdc === null && ing.source),
      `${id}: needs fdc, usda, or fdc null with a source`,
    );
    assert.ok(used.has(id), `${id} is not used by any meal`);
  }
});

test('the meal-plan folder loads diets before meals, with nutrition the server accepts', () => {
  const steps = planImport(root);
  const firstMeal = steps.findIndex((s) => s.label.startsWith('meal '));
  assert.ok(firstMeal > 0 && steps.slice(0, firstMeal).every((s) => s.label.startsWith('diet ')));
  assert.equal(steps.filter((s) => s.label.startsWith('diet ')).length, diets.length);
  for (const s of steps.filter((x) => x.label.startsWith('meal '))) {
    const { calories, proteinG, carbG, fatG } = s.body.nutrition;
    const fromMacros = 4 * proteinG + 4 * carbG + 9 * fatG;
    assert.ok(
      Math.abs(fromMacros - calories) <= Math.max(40, calories * 0.15),
      `${s.label}: ${calories} vs ${fromMacros}`,
    );
    assert.ok(calories >= 60 && calories <= 900, `${s.label}: ${calories} kcal is not a portion`);
    assert.ok(
      s.body.ingredients.every((i) => i.name && i.aisle),
      `${s.label}: ingredient names and aisles`,
    );
    assert.ok(!('slug' in s.body));
  }
});

test('meals keep the promises their diets make', () => {
  const known = new Set(diets.map((d) => d.slug));
  for (const m of meals) {
    const n = mealBody(m, table).nutrition;
    const kinds = new Set(m.ingredients.map((i) => table[i.id].kind));
    const proteinShare = (4 * n.proteinG) / n.calories;
    const carbShare = (4 * n.carbG) / n.calories;
    for (const d of m.diets) assert.ok(known.has(d), `${m.slug}: unknown diet ${d}`);
    if (m.diets.includes('high-protein'))
      assert.ok(proteinShare >= 0.25, `${m.slug}: ${Math.round(proteinShare * 100)}% protein`);
    if (m.diets.includes('low-carb'))
      assert.ok(carbShare <= 0.25, `${m.slug}: ${Math.round(carbShare * 100)}% carbs`);
    if (m.diets.includes('vegetarian'))
      assert.ok(!kinds.has('meat') && !kinds.has('fish'), `${m.slug}: meat or fish`);
    if (m.diets.includes('plant-based')) assert.deepEqual([...kinds], ['plant'], `${m.slug}: not all plants`);
    if (m.diets.includes('budget'))
      assert.ok(!m.ingredients.some((i) => table[i.id].pricey), `${m.slug}: pricey ingredient`);
  }
});

test('every diet has enough meals for each part of the day to vary a week', () => {
  for (const d of diets)
    for (const [slot, least] of [
      ['breakfast', 5],
      ['lunch', 5],
      ['dinner', 5],
      ['snack', 4],
    ]) {
      const count = meals.filter((m) => m.diets.includes(d.slug) && m.slots.includes(slot)).length;
      assert.ok(count >= least, `${d.slug} has ${count} ${slot} meals`);
    }
  for (const d of diets) {
    const s = d.split;
    assert.ok(Math.abs(s.breakfast + s.lunch + s.dinner + s.snack - 1) < 0.001, d.slug);
  }
});

test('every meal says how to make it, step by step, without amounts that portions would make wrong', () => {
  for (const m of meals) {
    assert.ok(m.steps.length >= 1, `${m.slug}: no steps`);
    if (m.minutes >= 15) assert.ok(m.steps.length >= 3, `${m.slug}: a cooked meal needs at least 3 steps`);
    for (const s of m.steps) {
      assert.ok(s.length <= 400 && /[.!?)]$/.test(s), `${m.slug}: "${s}" is too long or not a sentence`);
      // The app scales portions, so a weight in a step would be wrong at any other size: use the ingredient list.
      assert.doesNotMatch(s, /\b\d+\s?(g|kg|ml)\b/, `${m.slug}: "${s}" names an amount`);
    }
  }
});

test('planPrune deletes what the folder no longer has, meals before diets', () => {
  const steps = planPrune(root, { meals: ['banana', 'old-meal'], diets: ['balanced', 'old-diet'] });
  assert.deepEqual(
    steps.map((s) => `${s.method} ${s.path}`),
    ['DELETE /v1/admin/meals/old-meal', 'DELETE /v1/admin/diets/old-diet'],
  );
});

test('runImport waits when the admin API says slow down', async () => {
  let calls = 0;
  const waits = [];
  const fetcher = async () =>
    ++calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '7' } }) : new Response('{}');
  const failed = await runImport([{ label: 'diet x', method: 'PUT', path: '/v1/admin/diets/x', body: {} }], {
    base: 'https://api.example.com',
    key: 'k',
    fetcher,
    log: () => {},
    wait: async (ms) => waits.push(ms),
  });
  assert.equal(failed, 0);
  assert.deepEqual(waits, [7000]);
});

test('checkIngredients matches USDA by id or description, and flags differences and unknown foods', () => {
  const foods = [
    {
      externalId: 'fdc:1',
      name: 'Oats, dry',
      calories100g: 379,
      protein100g: 13.15,
      carb100g: 67.7,
      fat100g: 6.52,
      fiber100g: 10.1,
    },
    {
      externalId: 'fdc:2',
      name: 'Milk, reduced fat',
      calories100g: 50,
      protein100g: 3.3,
      carb100g: 4.8,
      fat100g: 1.98,
    },
    {
      externalId: 'fdc:3',
      name: 'Bananas, raw',
      calories100g: 89,
      protein100g: 1.09,
      carb100g: 22.84,
      fat100g: 0.33,
    },
  ];
  const t = {
    oats: { name: 'Oats', fdc: 1, per100g: { kcal: 380, protein: 13.2, carb: 67.7, fat: 6.5, fibre: 10.1 } },
    milk: { name: 'Milk', usda: 'milk, REDUCED fat', per100g: { kcal: 64, protein: 3.3, carb: 4.8, fat: 2 } },
    banana: {
      name: 'Banana',
      usda: 'Banana, ripe',
      per100g: { kcal: 89, protein: 1.1, carb: 22.8, fat: 0.3 },
    },
    rusk: {
      name: 'Rusk',
      fdc: null,
      source: 'Label average',
      per100g: { kcal: 420, protein: 8, carb: 70, fat: 12 },
    },
  };
  const r = Object.fromEntries(checkIngredients(t, foods).map((x) => [x.id, x]));
  assert.equal(r.oats.status, 'ok');
  assert.equal(r.milk.status, 'differs');
  assert.deepEqual(r.milk.differs, ['kcal']);
  assert.equal(r.banana.status, 'missing');
  assert.equal(r.banana.near[0].externalId, 'fdc:3');
  assert.equal(r.rusk.status, 'own');
  assert.deepEqual(per100gOf(foods[0]), { kcal: 379, protein: 13.2, carb: 67.7, fat: 6.5, fibre: 10.1 });
});
