#!/usr/bin/env node
// Loads foods into the shared catalogue through the admin API, from a file you obtained legitimately.
//
//   API_BASE=https://api-stage.example.com ADMIN_API_KEY=... \
//     node scripts/import-foods.mjs <file> --format usda|csv|json [--source curated] [--dry-run] [--limit 500]
//   node scripts/import-foods.mjs <file> --format usda --convert-only --out foods.json     (no server needed)
//
// Formats
//   usda  USDA FoodData Central JSON download (Foundation, SR Legacy, Survey/FNDDS, or a Branded file trimmed to a size
//         that fits in memory). Public domain (CC0): https://fdc.nal.usda.gov/download-datasets.html
//   csv   one food per row; header = the field names below. `aliases` separated by | or ;
//   json  an array of foods, or { "foods": [...] }
//
// Fields (all nutrition is per 100 g): source, externalId, name, brand, barcode, servingG, servingLabel, calories100g,
// protein100g, carb100g, fat100g, fiber100g, sugar100g, sodiumMg100g, dishId, aliases
//
// NOTHING IS ESTIMATED. A USDA food with no energy figure, or no protein, fat or carbohydrate figure, is skipped and counted,
// not guessed. For South African foods, bring figures from SAFOODS (the South African Food Composition Database, SAMRC) or
// from weighed/lab data, and put the reference in externalId (for example safoods:<code>).
import { readFileSync, writeFileSync } from 'node:fs';

const MAX_PER_CALL = 100;

// ---- USDA ------------------------------------------------------------------------------------------------------

// nutrient numbers, first match wins
const NUTRIENTS = {
  calories100g: ['208', '957', '958'], // Energy kcal, then Atwater general / specific factors (also kcal)
  protein100g: ['203'],
  fat100g: ['204', '298'],
  carb100g: ['205'],
  fiber100g: ['291'],
  sugar100g: ['269', '269.3', '269.2'],
  sodiumMg100g: ['307'],
};

function toMilligramsOrGrams(value, unit, wanted) {
  const u = String(unit ?? '').toLowerCase();
  if (wanted === 'mg') return u === 'g' ? value * 1000 : u === 'ug' || u === 'µg' ? value / 1000 : value;
  return u === 'mg' ? value / 1000 : u === 'ug' || u === 'µg' ? value / 1e6 : value;
}

function nutrientValue(list, numbers, wanted) {
  for (const number of numbers) {
    const hit = list.find((n) => String(n.nutrient?.number ?? n.nutrientNumber) === number);
    const raw = hit?.amount ?? hit?.value;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) continue;
    const unit = hit.nutrient?.unitName ?? hit.unitName;
    if (wanted === 'kcal' && unit && String(unit).toLowerCase() !== 'kcal') continue; // never read kJ as kcal
    return wanted === 'kcal' ? raw : toMilligramsOrGrams(raw, unit, wanted);
  }
  return null;
}

const niceName = (s) =>
  s === s.toUpperCase() && /[A-Z]/.test(s)
    ? s.toLowerCase().replace(/(^|[\s(,/-])([a-z])/g, (_, a, b) => a + b.toUpperCase())
    : s;

function servingOf(food) {
  if (food.servingSizeUnit && /^g(ram)?s?$/i.test(food.servingSizeUnit) && food.servingSize > 0)
    return {
      servingG: food.servingSize,
      servingLabel: (food.householdServingFullText || `${food.servingSize} g`).slice(0, 60),
    };
  const p = (food.foodPortions ?? []).find((x) => x.gramWeight > 0);
  if (!p) return {};
  const unit = p.measureUnit?.name && p.measureUnit.name !== 'undetermined' ? p.measureUnit.name : '';
  const label = (
    p.portionDescription || [p.amount, unit, p.modifier].filter((x) => x !== undefined && x !== '').join(' ')
  ).trim();
  return {
    servingG: Math.round(p.gramWeight * 10) / 10,
    ...(label ? { servingLabel: label.slice(0, 60) } : {}),
  };
}

/** USDA foods -> import payloads, plus why each skipped food was skipped. Pure. */
export function convertUsda(json) {
  const list = Array.isArray(json)
    ? json
    : (json.FoundationFoods ??
      json.SRLegacyFoods ??
      json.SurveyFoods ??
      json.BrandedFoods ??
      json.foods ??
      []);
  const foods = [];
  const skipped = [];
  for (const f of list) {
    const id = `fdc:${f.fdcId}`;
    if (!f.fdcId || !f.description) {
      skipped.push({ id, reason: 'no id or description' });
      continue;
    }
    const n = f.foodNutrients ?? [];
    const got = {};
    for (const [field, numbers] of Object.entries(NUTRIENTS))
      got[field] = nutrientValue(
        n,
        numbers,
        field === 'calories100g' ? 'kcal' : field === 'sodiumMg100g' ? 'mg' : 'g',
      );
    const missing = ['calories100g', 'protein100g', 'fat100g', 'carb100g'].filter((k) => got[k] === null);
    if (missing.length) {
      skipped.push({ id, reason: `no ${missing.join(', ')} figure` });
      continue;
    }
    const gtin = typeof f.gtinUpc === 'string' && /^\d{8,14}$/.test(f.gtinUpc) ? f.gtinUpc : undefined;
    foods.push({
      source: 'usda',
      externalId: id,
      name: niceName(f.description).slice(0, 200),
      ...(f.brandOwner || f.brandName ? { brand: String(f.brandName || f.brandOwner).slice(0, 100) } : {}),
      ...(gtin ? { barcode: gtin } : {}),
      ...servingOf(f),
      ...Object.fromEntries(
        Object.entries(got)
          .filter(([, v]) => v !== null)
          .map(([k, v]) => [k, Math.round(v * 100) / 100]),
      ),
    });
  }
  return { foods, skipped };
}

// ---- CSV -------------------------------------------------------------------------------------------------------

/** RFC 4180 style: quoted fields may contain commas, quotes ("") and new lines. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

const NUMERIC = [
  'servingG',
  'calories100g',
  'protein100g',
  'carb100g',
  'fat100g',
  'fiber100g',
  'sugar100g',
  'sodiumMg100g',
];

export function convertCsv(text, defaults = {}) {
  const [header, ...rows] = parseCsv(text);
  if (!header) return { foods: [], skipped: [] };
  const names = header.map((h) => h.trim());
  const foods = [];
  const skipped = [];
  rows.forEach((cells, i) => {
    const food = { ...defaults };
    names.forEach((name, c) => {
      const v = (cells[c] ?? '').trim();
      if (v === '' || !name) return;
      if (NUMERIC.includes(name)) food[name] = Number(v);
      else if (name === 'aliases')
        food.aliases = v
          .split(/[|;]/)
          .map((a) => a.trim())
          .filter(Boolean);
      else food[name] = v;
    });
    const bad = NUMERIC.find((k) => k in food && !Number.isFinite(food[k]));
    if (bad) skipped.push({ id: food.externalId ?? `row ${i + 2}`, reason: `${bad} is not a number` });
    else foods.push(food);
  });
  return { foods, skipped };
}

export function convertJson(json, defaults = {}) {
  const list = Array.isArray(json) ? json : (json.foods ?? []);
  return { foods: list.map((f) => ({ ...defaults, ...f })), skipped: [] };
}

// ---- sending ---------------------------------------------------------------------------------------------------

export const chunks = (items, size = MAX_PER_CALL) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

export async function sendFoods(foods, { base, key, dryRun = false, fetcher = fetch, log = console.log }) {
  const total = { created: 0, updated: 0, rejected: [], warnings: 0, failedCalls: 0 };
  let offset = 0;
  for (const part of chunks(foods)) {
    const res = await fetcher(base.replace(/\/$/, '') + '/v1/admin/foods/import', {
      method: 'POST',
      headers: { 'x-admin-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ foods: part, dryRun }),
    });
    if (!res.ok) {
      total.failedCalls++;
      log(
        `FAIL  foods ${offset + 1}-${offset + part.length}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`,
      );
    } else {
      const r = await res.json();
      total.created += r.created;
      total.updated += r.updated;
      total.warnings += r.warnings.length;
      for (const x of r.rejected) total.rejected.push({ ...x, index: x.index + offset });
      log(
        `ok    foods ${offset + 1}-${offset + part.length}: ${r.created} new, ${r.updated} updated, ${r.rejected.length} rejected`,
      );
    }
    offset += part.length;
  }
  return total;
}

// ---- command line ----------------------------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const file = args[0];
  const format = flag('format');
  const fail = (m) => {
    console.error(m);
    process.exit(1);
  };
  if (!file || file.startsWith('--') || !['usda', 'csv', 'json'].includes(format ?? ''))
    fail(
      'usage: node scripts/import-foods.mjs <file> --format usda|csv|json [--source curated] [--dry-run] [--limit N] [--convert-only --out file.json]',
    );
  const defaults = flag('source') ? { source: flag('source') } : {};
  const text = readFileSync(file, 'utf8');
  const converted =
    format === 'usda'
      ? convertUsda(JSON.parse(text))
      : format === 'csv'
        ? convertCsv(text, defaults)
        : convertJson(JSON.parse(text), defaults);
  const limit = Number(flag('limit') ?? Infinity);
  const foods = converted.foods.slice(0, limit);
  console.log(`${foods.length} foods ready, ${converted.skipped.length} skipped`);
  const reasons = {};
  for (const s of converted.skipped) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
  for (const [reason, n] of Object.entries(reasons)) console.log(`  skipped ${n}: ${reason}`);

  if (args.includes('--convert-only')) {
    const out = flag('out') ?? fail('--convert-only needs --out <file>');
    writeFileSync(out, JSON.stringify(foods, null, 1));
    console.log(`wrote ${out}`);
  } else {
    const base = process.env.API_BASE;
    const key = process.env.ADMIN_API_KEY;
    if (!base || !key) fail('set API_BASE and ADMIN_API_KEY');
    const total = await sendFoods(foods, { base, key, dryRun: args.includes('--dry-run') });
    console.log(
      `${args.includes('--dry-run') ? 'would add' : 'added'} ${total.created}, updated ${total.updated}, rejected ${total.rejected.length}, warnings ${total.warnings}`,
    );
    for (const r of total.rejected.slice(0, 20))
      console.log(`  rejected #${r.index} ${r.externalId ?? ''}: ${r.reason}`);
    process.exit(total.failedCalls || total.rejected.length ? 1 : 0);
  }
}
