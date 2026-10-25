#!/usr/bin/env node
// Loads content (workouts, and meal plans) from a folder into an environment through the admin API.
// Safe to run again: everything is addressed by its slug or key, so it updates in place.
//
//   API_BASE=https://pango-api-stage.lightarch.io ADMIN_API_KEY=... node scripts/import-content.mjs content/sample [--publish]
//   ... node scripts/import-content.mjs content/meal-plans --prune
//
// Folder layout:
//   media/*.json       { "key": "squat-demo", "kind": "video", "provider": "external", "location": "https://...", "tier": "free" }
//   exercises/*.json   { "slug": "barbell-back-squat", "name": "...", "muscleGroups": [...], ... }
//   programs/*.json    { "slug": "beginner-strength", "title": "...", "workouts": [...], ... }
//   ingredients.json   { "oats": { "name": "Rolled oats", "per100g": { "kcal": 379, "protein": 13.2, ... }, "fdc": 173904 } }
//   diets/*.json       { "slug": "balanced", "title": "...", "tier": "free", "split": {...}, ... }
//   meals/*.json       { "slug": "...", "diets": [...], "ingredients": [{ "id": "oats", "grams": 50 }], ... }
// Files are read in that order, because each refers to the one before. A meal's nutrition is worked out here from its
// ingredients (docs/meal-plans.md). --prune deletes meals and diets on the server that the folder no longer has.
// Only use content you own or are licensed to use. Put credit in each exercise's "source" and "licence".
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Read every JSON file in a folder, sorted by name. */
export function readJsonFolder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ file: f, data: JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
}

/** The requests to make, in order. Pure, so it can be checked without a server. */
export function planImport(root, { publish = false } = {}) {
  const steps = [];
  for (const { file, data } of readJsonFolder(join(root, 'media'))) {
    const { key, ...body } = data;
    if (!key) throw new Error(`media/${file}: missing "key"`);
    steps.push({ label: `media ${key}`, method: 'PUT', path: `/v1/admin/media/${key}`, body });
  }
  for (const { file, data } of readJsonFolder(join(root, 'exercises'))) {
    const { slug, ...body } = data;
    if (!slug) throw new Error(`exercises/${file}: missing "slug"`);
    steps.push({ label: `exercise ${slug}`, method: 'PUT', path: `/v1/admin/exercises/${slug}`, body });
  }
  for (const { file, data } of readJsonFolder(join(root, 'programs'))) {
    const { slug, ...body } = data;
    if (!slug) throw new Error(`programs/${file}: missing "slug"`);
    steps.push({ label: `program ${slug}`, method: 'PUT', path: `/v1/admin/programs/${slug}`, body });
    if (publish)
      steps.push({ label: `publish ${slug}`, method: 'POST', path: `/v1/admin/programs/${slug}/publish` });
  }
  for (const { file, data } of readJsonFolder(join(root, 'diets'))) {
    const { slug, ...body } = data;
    if (!slug) throw new Error(`diets/${file}: missing "slug"`);
    steps.push({ label: `diet ${slug}`, method: 'PUT', path: `/v1/admin/diets/${slug}`, body });
  }
  const meals = readJsonFolder(join(root, 'meals'));
  if (meals.length) {
    const table = JSON.parse(readFileSync(join(root, 'ingredients.json'), 'utf8'));
    for (const { file, data } of meals) {
      if (!data.slug) throw new Error(`meals/${file}: missing "slug"`);
      let body;
      try {
        body = mealBody(data, table);
      } catch (e) {
        throw new Error(`meals/${file}: ${e.message}`);
      }
      steps.push({ label: `meal ${data.slug}`, method: 'PUT', path: `/v1/admin/meals/${data.slug}`, body });
    }
  }
  return steps;
}

const round1 = (n) => Math.round(n * 10) / 10;

/** One portion's nutrition from its ingredients and the ingredient table (values per 100 g). Pure. */
export function mealNutrition(items, table) {
  const sum = { kcal: 0, protein: 0, carb: 0, fat: 0, fibre: 0 };
  let fibreKnown = true;
  for (const { id, grams } of items) {
    const ing = table[id];
    if (!ing) throw new Error(`unknown ingredient "${id}"`);
    if (!(grams > 0)) throw new Error(`ingredient "${id}" needs grams above 0`);
    for (const k of ['kcal', 'protein', 'carb', 'fat']) sum[k] += (ing.per100g[k] * grams) / 100;
    if (typeof ing.per100g.fibre === 'number') sum.fibre += (ing.per100g.fibre * grams) / 100;
    else fibreKnown = false;
  }
  return {
    calories: Math.round(sum.kcal),
    proteinG: round1(sum.protein),
    carbG: round1(sum.carb),
    fatG: round1(sum.fat),
    fibreG: fibreKnown ? round1(sum.fibre) : null,
  };
}

/** A meal file -> the admin API body: ingredient names and nutrition filled in from the table. Pure. */
export function mealBody(data, table) {
  const { slug, ingredients, ...rest } = data;
  return {
    ...rest,
    ingredients: ingredients.map((i) => ({
      name: i.name ?? table[i.id]?.name ?? i.id,
      grams: i.grams,
      measure: i.measure ?? null,
      aisle: table[i.id]?.aisle ?? null,
    })),
    nutrition: mealNutrition(ingredients, table),
    source: 'Worked out from the ingredients with USDA FoodData Central figures',
  };
}

/** The deletes --prune makes: meals first (a diet in use cannot go), then diets. Pure. */
export function planPrune(root, existing) {
  const keep = (folder) => new Set(readJsonFolder(join(root, folder)).map(({ data }) => data.slug));
  const meals = keep('meals');
  const diets = keep('diets');
  return [
    ...existing.meals
      .filter((s) => !meals.has(s))
      .map((s) => ({ label: `delete meal ${s}`, method: 'DELETE', path: `/v1/admin/meals/${s}` })),
    ...existing.diets
      .filter((s) => !diets.has(s))
      .map((s) => ({ label: `delete diet ${s}`, method: 'DELETE', path: `/v1/admin/diets/${s}` })),
  ];
}

export async function runImport(
  steps,
  { base, key, fetcher = fetch, log = console.log, wait = (ms) => new Promise((r) => setTimeout(r, ms)) },
) {
  let failed = 0;
  for (const step of steps) {
    const send = () =>
      fetcher(base.replace(/\/$/, '') + step.path, {
        method: step.method,
        headers: { 'x-admin-key': key, ...(step.body ? { 'content-type': 'application/json' } : {}) },
        body: step.body ? JSON.stringify(step.body) : undefined,
      });
    let res = await send();
    // The admin API allows 120 calls a minute: wait as long as it says and go on.
    for (let tries = 0; res.status === 429 && tries < 5; tries++) {
      const seconds = Math.min(Number(res.headers.get('retry-after')) || 30, 120);
      log(`wait  ${seconds} s (HTTP 429)`);
      await wait(seconds * 1000);
      res = await send();
    }
    if (res.ok) log(`ok    ${step.label}`);
    else {
      failed++;
      log(`FAIL  ${step.label}: HTTP ${res.status} ${(await res.text()).slice(0, 400)}`);
    }
  }
  return failed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2];
  const base = process.env.API_BASE;
  const key = process.env.ADMIN_API_KEY;
  if (!root || !base || !key) {
    console.error(
      'usage: API_BASE=https://... ADMIN_API_KEY=... node scripts/import-content.mjs <folder> [--publish]',
    );
    process.exit(1);
  }
  const steps = planImport(root, { publish: process.argv.includes('--publish') });
  if (process.argv.includes('--prune')) {
    const res = await fetch(base.replace(/\/$/, '') + '/v1/admin/meal-plans', {
      headers: { 'x-admin-key': key },
    });
    if (!res.ok) {
      console.error(`Could not list meal plans to prune: HTTP ${res.status}`);
      process.exit(1);
    }
    steps.push(...planPrune(root, await res.json()));
  }
  console.log(`${steps.length} steps`);
  process.exit((await runImport(steps, { base, key })) ? 1 : 0);
}
