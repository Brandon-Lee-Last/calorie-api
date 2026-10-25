#!/usr/bin/env node
// Checks the meal-plan ingredient table against USDA FoodData Central, so every meal's numbers rest on public data.
//
//   node scripts/check-ingredients.mjs content/meal-plans/ingredients.json <usda foundation json> <usda sr legacy json>
//
// Each ingredient names its USDA food by "fdc" (the FoodData Central id), or by "usda" (the exact description) until
// the id is known. Its per-100 g figures must match USDA's (kcal within 3% or 5 kcal, the rest within 5% or 0.5 g).
// For each one it prints the USDA figures as a JSON line to paste back, and for a food it cannot find, the closest
// USDA descriptions. An ingredient USDA does not have needs "fdc": null and a "source" saying where its figures are from.
import { appendFileSync, readFileSync } from 'node:fs';
import { convertUsda } from './import-foods.mjs';

const FIELDS = [
  ['kcal', 'calories100g'],
  ['protein', 'protein100g'],
  ['carb', 'carb100g'],
  ['fat', 'fat100g'],
  ['fibre', 'fiber100g'],
];
const close = (field, ours, theirs) =>
  field === 'kcal'
    ? Math.abs(ours - theirs) <= Math.max(5, theirs * 0.03)
    : Math.abs(ours - theirs) <= Math.max(0.5, theirs * 0.05);
/** Lowercase words, with simple plurals made singular ("tomatoes" and "tomato" match). */
const words = (s) =>
  new Set(
    String(s)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1)
      .map((w) => (w.length > 4 ? w.replace(/(oes|s)$/, (m) => (m === 'oes' ? 'o' : '')) : w)),
  );
const round1 = (n) => Math.round(n * 10) / 10;

/** The USDA figures in the table's shape. */
export const per100gOf = (food) =>
  Object.fromEntries(
    FIELDS.filter(([, theirs]) => typeof food[theirs] === 'number').map(([ours, theirs]) => [
      ours,
      round1(food[theirs]),
    ]),
  );

/** Compares each ingredient with USDA. Pure: `foods` are convertUsda() results. */
export function checkIngredients(table, foods) {
  const byId = new Map(foods.map((f) => [Number(f.externalId.replace('fdc:', '')), f]));
  const byName = new Map(foods.map((f) => [f.name.toLowerCase(), f]));
  return Object.entries(table).map(([id, ing]) => {
    if (ing.fdc === null) return { id, status: ing.source ? 'own' : 'missing', ing };
    const food = (ing.fdc && byId.get(ing.fdc)) || (ing.usda && byName.get(ing.usda.toLowerCase())) || null;
    if (!food) {
      const want = words(ing.usda ?? ing.name);
      const near = foods
        .map((f) => {
          const have = words(f.name);
          let hits = 0;
          for (const w of want) if (have.has(w)) hits++;
          return { f, score: hits / (want.size + have.size * 0.15) };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
        .map(({ f }) => f);
      return { id, status: 'missing', ing, near };
    }
    const differs = FIELDS.filter(([ours, theirs]) => {
      const t = food[theirs];
      const o = ing.per100g?.[ours];
      if (typeof t !== 'number') return false;
      return typeof o !== 'number' || !close(ours, o, t);
    }).map(([ours]) => ours);
    return { id, status: differs.length ? 'differs' : 'ok', ing, food, differs };
  });
}

const fdcOf = (food) => Number(food.externalId.replace('fdc:', ''));
const line = (id, ing, food) =>
  `  ${JSON.stringify(id)}: ${JSON.stringify({ name: ing.name, per100g: per100gOf(food), fdc: fdcOf(food) })},`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const [tablePath, ...usdaPaths] = process.argv.slice(2);
  if (!tablePath || usdaPaths.length === 0) {
    console.error('usage: check-ingredients.mjs <ingredients.json> <usda json>...');
    process.exit(1);
  }
  const table = JSON.parse(readFileSync(tablePath, 'utf8'));
  const foods = usdaPaths.flatMap((p) => convertUsda(JSON.parse(readFileSync(p, 'utf8'))).foods);
  const results = checkIngredients(table, foods);
  const out = [];
  for (const r of results) {
    if (r.status === 'ok') out.push(`ok       ${r.id}: ${r.food.name} (${fdcOf(r.food)})`);
    else if (r.status === 'own') out.push(`own      ${r.id}: ${r.ing.source}`);
    else if (r.status === 'differs') {
      out.push(`DIFFERS  ${r.id}: ${r.food.name} (${fdcOf(r.food)}) in ${r.differs.join(', ')}`);
      out.push(`         ours ${JSON.stringify(r.ing.per100g)}`);
      out.push(`         usda ${JSON.stringify(per100gOf(r.food))}`);
    } else {
      out.push(`MISSING  ${r.id}: no USDA food "${r.ing.usda ?? r.ing.fdc ?? r.ing.name}". Closest:`);
      for (const f of r.near ?? [])
        out.push(`         ${fdcOf(f)}  ${f.name}  ${JSON.stringify(per100gOf(f))}`);
    }
  }
  const bad = results.filter((r) => r.status === 'differs' || r.status === 'missing');
  out.push('', `${results.length} ingredients: ${results.length - bad.length} fine, ${bad.length} to fix.`);
  out.push('', 'USDA figures for every ingredient it found (paste into ingredients.json):');
  for (const r of results) if (r.food) out.push(line(r.id, r.ing, r.food));
  const text = out.join('\n');
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + text + '\n```\n');
  process.exit(bad.length ? 1 : 0);
}
