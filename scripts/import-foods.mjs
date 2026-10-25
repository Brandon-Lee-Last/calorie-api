#!/usr/bin/env node
// Loads foods into the shared catalogue through the admin API, from a file you obtained legitimately.
//
//   API_BASE=https://api-stage.example.com ADMIN_API_KEY=... \
//     node scripts/import-foods.mjs <file> --format usda|csv|json|off [--source curated] [--dry-run] [--limit 500]
//   node scripts/import-foods.mjs <file> --format usda --convert-only --out foods.json     (no server needed)
//   node scripts/import-foods.mjs https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz \
//     --format off --country en:south-africa --convert-only --out foods-off.json
//
// Formats
//   usda  USDA FoodData Central JSON download (Foundation, SR Legacy, Survey/FNDDS, or a Branded file trimmed to a size
//         that fits in memory). Public domain (CC0): https://fdc.nal.usda.gov/download-datasets.html
//   csv   one food per row; header = the field names below. `aliases` separated by | or ;
//   json  an array of foods, or { "foods": [...] }
//   off   Open Food Facts JSONL export, one product per line, plain or .gz, a file or an https URL. ODbL: credit Open Food
//         Facts wherever the foods are shown, and share this part of the catalogue under the ODbL if asked. It is read
//         as a stream (the full export is many gigabytes); --country keeps products sold there (comma-separated tags,
//         default en:south-africa, or `all`). https://world.openfoodfacts.org/data
//
// Fields (all nutrition is per 100 g): source, externalId, name, brand, barcode, servingG, servingLabel, calories100g,
// protein100g, carb100g, fat100g, fiber100g, sugar100g, sodiumMg100g, dishId, aliases
//
// NOTHING IS ESTIMATED. A USDA food with no energy figure, or no protein, fat or carbohydrate figure, is skipped and counted,
// not guessed. For South African foods, bring figures from SAFOODS (the South African Food Composition Database, SAMRC) or
// from weighed/lab data, and put the reference in externalId (for example safoods:<code>).
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { convertOffProduct } from './off-products.mjs';

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
    if (!f || typeof f !== 'object') {
      skipped.push({ id: '?', reason: 'not a food record' });
      continue;
    }
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

// ---- Open Food Facts -------------------------------------------------------------------------------------------

/** Lines of a file or URL, gunzipped when the name ends in .gz, without holding the whole thing anywhere. */
export async function* readLines(source, fetcher = fetch) {
  let stream;
  if (/^https?:\/\//.test(source)) {
    const res = await fetcher(source, { headers: { 'user-agent': 'calorie-api food import' } });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${source}`);
    stream = Readable.fromWeb(res.body);
  } else stream = createReadStream(source);
  if (/\.gz($|\?)/.test(source)) stream = stream.pipe(createGunzip());
  yield* createInterface({ input: stream, crlfDelay: Infinity });
}

/**
 * Open Food Facts products (JSON lines) -> import payloads. Only products tagged with one of `countries` are read, and
 * the tag is looked for in the raw line first, so the millions of other products are never parsed.
 */
export async function convertOffLines(lines, { countries = ['en:south-africa'], onProgress } = {}) {
  const all = countries.includes('all');
  const foods = [];
  const skipped = [];
  const seen = new Set();
  let scanned = 0;
  let matched = 0;
  for await (const line of lines) {
    scanned++;
    if (onProgress && scanned % 500_000 === 0) onProgress({ scanned, matched, kept: foods.length });
    if (!all && !countries.some((c) => line.includes(`"${c}"`))) continue;
    let product;
    try {
      product = JSON.parse(line);
    } catch {
      continue;
    }
    const tags = Array.isArray(product.countries_tags) ? product.countries_tags : [];
    if (!all && !countries.some((c) => tags.includes(c))) continue;
    matched++;
    const { food, skip } = convertOffProduct(product);
    const id = typeof product.code === 'string' ? product.code : '?';
    if (skip) skipped.push({ id, reason: skip });
    else if (seen.has(food.barcode)) skipped.push({ id, reason: 'barcode listed twice' });
    else {
      seen.add(food.barcode);
      foods.push(food);
    }
  }
  return { foods, skipped, scanned, matched };
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
  if (!file || file.startsWith('--') || !['usda', 'csv', 'json', 'off'].includes(format ?? ''))
    fail(
      'usage: node scripts/import-foods.mjs <file or URL> --format usda|csv|json|off [--country en:south-africa] [--source curated] [--dry-run] [--limit N] [--convert-only --out file.json]',
    );
  const defaults = flag('source') ? { source: flag('source') } : {};
  let converted;
  if (format === 'off') {
    const countries = (flag('country') ?? 'en:south-africa')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    const started = Date.now();
    converted = await convertOffLines(readLines(file), {
      countries,
      onProgress: ({ scanned, matched, kept }) =>
        console.log(
          `  read ${scanned.toLocaleString('en')} products, ${matched} in ${countries.join(', ')}, ${kept} usable (${Math.round((Date.now() - started) / 1000)} s)`,
        ),
    });
    console.log(`read ${converted.scanned} products, ${converted.matched} sold in ${countries.join(', ')}`);
  } else {
    const text = readFileSync(file, 'utf8');
    converted =
      format === 'usda'
        ? convertUsda(JSON.parse(text))
        : format === 'csv'
          ? convertCsv(text, defaults)
          : convertJson(JSON.parse(text), defaults);
  }
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
