// Tests for the deploy scripts. Run with: npm run test:scripts  (plain Node, no Cloudflare needed)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { planImport, runImport } from './import-content.mjs';
import {
  COLUMNS,
  classify,
  exportContributions,
  isTestDonor,
  toCsv,
  trainRow,
} from './export-training-data.mjs';
import { scanRepo, scanText } from './secret-scan.mjs';
import { gzipSync } from 'node:zlib';
import {
  chunks,
  convertCsv,
  convertJson,
  convertOffLines,
  convertUsda,
  parseCsv,
  readLines,
  sendFoods,
} from './import-foods.mjs';
import { convertOffProduct } from './off-products.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (script, args = [], env = {}) =>
  spawnSync('node', [`scripts/${script}`, ...args], {
    cwd: root,
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });

test('render-wrangler fills the placeholders for an environment', () => {
  const out = fileURLToPath(new URL('../wrangler.rendered.jsonc', import.meta.url));
  rmSync(out, { force: true });
  const r = run('render-wrangler.mjs', [], {
    D1_DATABASE_ID: 'abc-123',
    API_HOST: 'api-stage.example.com',
    GOOGLE_CLIENT_IDS: 'one.apps,two.apps',
  });
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(out, 'utf8');
  assert.ok(text.includes('"database_id": "abc-123"'));
  assert.ok(text.includes('"pattern": "api-stage.example.com"'));
  assert.ok(text.includes('one.apps,two.apps'));
  assert.ok(!/__[A-Z0-9_]+__/.test(text), 'no placeholder left');
  rmSync(out, { force: true });
});

test('render-wrangler refuses to run with a value missing', () => {
  const r = run('render-wrangler.mjs', [], { API_HOST: 'x.example.com' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /D1_DATABASE_ID/);
});

test('render-wrangler does not let a value break out of the JSON', () => {
  const out = fileURLToPath(new URL('../wrangler.rendered.jsonc', import.meta.url));
  const r = run('render-wrangler.mjs', [], { D1_DATABASE_ID: 'a"b', API_HOST: 'h.example.com' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(readFileSync(out, 'utf8').includes('"database_id": "ab"'));
  rmSync(out, { force: true });
});

test('sync-secrets checks secrets before sending anything, and never prints their values', () => {
  const good = {
    JWT_SECRET: 'j'.repeat(40),
    MEDIA_SIGNING_SECRET: 'm'.repeat(40),
    ADMIN_API_KEY: 'a'.repeat(30),
  };
  const ok = run('sync-secrets.mjs', ['stage', '--dry-run'], good);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /JWT_SECRET, MEDIA_SIGNING_SECRET, ADMIN_API_KEY/);
  assert.ok(!ok.stdout.includes('jjjj'));

  const weak = run('sync-secrets.mjs', ['production', '--dry-run'], { ...good, JWT_SECRET: 'short' });
  assert.notEqual(weak.status, 0);
  assert.match(weak.stderr, /JWT_SECRET must be at least 32/);

  const missing = run('sync-secrets.mjs', ['stage', '--dry-run'], { JWT_SECRET: good.JWT_SECRET });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /MEDIA_SIGNING_SECRET is not set/);

  assert.notEqual(run('sync-secrets.mjs', ['qa', '--dry-run'], good).status, 0);
});

test('sync-secrets passes optional secrets along when present', () => {
  const r = run('sync-secrets.mjs', ['stage', '--dry-run'], {
    JWT_SECRET: 'j'.repeat(40),
    MEDIA_SIGNING_SECRET: 'm'.repeat(40),
    ADMIN_API_KEY: 'a'.repeat(30),
    OFF_USER_AGENT: 'CalorieApp/1 (me@example.com)',
  });
  assert.match(r.stdout, /OFF_USER_AGENT/);
});

test('the wrangler config has the same bindings in every environment', () => {
  // wrangler.jsonc allows comments and trailing commas; strip them to read it as plain JSON.
  const text = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
  const config = JSON.parse(text);
  for (const env of ['stage', 'production']) {
    const c = config.env[env];
    assert.ok(c.d1_databases[0].binding === 'DB', `${env} DB`);
    assert.ok(c.r2_buckets[0].binding === 'MEDIA', `${env} MEDIA`);
    assert.ok(c.ai.binding === 'AI', `${env} AI`);
    assert.deepEqual(
      c.triggers.crons,
      ['17 3 * * *', '*/5 * * * *'],
      `${env} crons: nightly maintenance and the reminder job`,
    );
    for (const v of Object.keys(config.vars)) assert.ok(v in c.vars, `${env} is missing var ${v}`);
  }
  assert.equal(
    config.env.production.vars.SIMULATE_ENABLED,
    'false',
    'production must not expose the simulate endpoints',
  );
  assert.notEqual(
    config.env.stage.d1_databases[0].database_name,
    config.env.production.d1_databases[0].database_name,
  );
  assert.notEqual(
    config.env.stage.r2_buckets[0].bucket_name,
    config.env.production.r2_buckets[0].bucket_name,
  );
});

test('import-content plans media, then exercises, then programs, with optional publishing', () => {
  const steps = planImport(fileURLToPath(new URL('../content/sample', import.meta.url)), { publish: true });
  const labels = steps.map((s) => s.label);
  assert.deepEqual(
    labels.filter((l) => l.startsWith('exercise')),
    ['exercise barbell-back-squat', 'exercise plank', 'exercise push-up'],
  );
  assert.ok(labels.indexOf('exercise push-up') < labels.indexOf('program starter-bodyweight'));
  assert.equal(labels.at(-1), 'publish starter-bodyweight');
  assert.ok(!('slug' in steps[0].body), 'the slug travels in the URL, not the body');
  assert.equal(
    planImport(fileURLToPath(new URL('../content/sample', import.meta.url))).length,
    steps.length - 1,
  );
});

test('import-content sends the admin key and reports failures', async () => {
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push({ url, key: init.headers['x-admin-key'], method: init.method });
    return url.endsWith('/plank')
      ? new Response('nope', { status: 422 })
      : new Response('{}', { status: 200 });
  };
  const logs = [];
  const failed = await runImport(
    [
      { label: 'exercise push-up', method: 'PUT', path: '/v1/admin/exercises/push-up', body: {} },
      { label: 'exercise plank', method: 'PUT', path: '/v1/admin/exercises/plank', body: {} },
    ],
    { base: 'https://api.example.com/', key: 'secret-key', fetcher, log: (l) => logs.push(l) },
  );
  assert.equal(failed, 1);
  assert.deepEqual(
    seen.map((s) => s.url),
    [
      'https://api.example.com/v1/admin/exercises/push-up',
      'https://api.example.com/v1/admin/exercises/plank',
    ],
  );
  assert.ok(seen.every((s) => s.key === 'secret-key'));
  assert.match(logs[1], /FAIL .*422/);
});

test('import-content refuses files without a slug or key', () => {
  const dir = fileURLToPath(new URL('./.tmp-content', import.meta.url));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(`${dir}/exercises`, { recursive: true });
  writeFileSync(`${dir}/exercises/bad.json`, '{"name":"No slug"}');
  assert.throws(() => planImport(dir), /missing "slug"/);
  rmSync(dir, { recursive: true, force: true });
});

// ---- import-foods ----------------------------------------------------------------------------------------------

const nutrient = (number, amount, unitName = 'g') => ({
  nutrient: { number: String(number), unitName },
  amount,
});
const usdaRice = {
  fdcId: 168878,
  description: 'Rice, white, long-grain, regular, cooked',
  foodNutrients: [
    nutrient(208, 130, 'kcal'),
    nutrient(203, 2.69),
    nutrient(204, 0.28),
    nutrient(205, 28.17),
    nutrient(291, 0.4),
    nutrient(269, 0.05),
    nutrient(307, 1, 'mg'),
  ],
  foodPortions: [{ amount: 1, modifier: 'cup', measureUnit: { name: 'undetermined' }, gramWeight: 158 }],
};

test('USDA conversion maps nutrient numbers to our fields and keeps a serving', () => {
  const { foods, skipped } = convertUsda({ SRLegacyFoods: [usdaRice] });
  assert.deepEqual(skipped, []);
  assert.deepEqual(foods, [
    {
      source: 'usda',
      externalId: 'fdc:168878',
      name: 'Rice, white, long-grain, regular, cooked',
      servingG: 158,
      servingLabel: '1 cup',
      calories100g: 130,
      protein100g: 2.69,
      fat100g: 0.28,
      carb100g: 28.17,
      fiber100g: 0.4,
      sugar100g: 0.05,
      sodiumMg100g: 1,
    },
  ]);
});

test('USDA conversion skips empty entries in a download instead of stopping', () => {
  const out = convertUsda({ FoundationFoods: [null, usdaRice, 'x'] });
  assert.equal(out.foods.length, 1);
  assert.deepEqual(
    out.skipped.map((s) => s.reason),
    ['not a food record', 'not a food record'],
  );
});

test('USDA conversion never estimates: a food missing energy or a macro is skipped, with the reason', () => {
  const noEnergy = {
    ...usdaRice,
    fdcId: 1,
    foodNutrients: usdaRice.foodNutrients.filter((n) => n.nutrient.number !== '208'),
  };
  const noProtein = {
    ...usdaRice,
    fdcId: 2,
    foodNutrients: usdaRice.foodNutrients.filter((n) => n.nutrient.number !== '203'),
  };
  const { foods, skipped } = convertUsda([noEnergy, noProtein, { fdcId: 3 }]);
  assert.equal(foods.length, 0);
  assert.deepEqual(
    skipped.map((s) => s.reason),
    ['no calories100g figure', 'no protein100g figure', 'no id or description'],
  );
});

test('USDA conversion uses the Atwater energy figure when 208 is absent, and never reads kJ as kcal', () => {
  const atwater = {
    ...usdaRice,
    fdcId: 4,
    foodNutrients: [
      ...usdaRice.foodNutrients.filter((n) => n.nutrient.number !== '208'),
      nutrient(957, 128, 'kcal'),
    ],
  };
  assert.equal(convertUsda([atwater]).foods[0].calories100g, 128);
  const kj = {
    ...usdaRice,
    fdcId: 5,
    foodNutrients: [
      ...usdaRice.foodNutrients.filter((n) => n.nutrient.number !== '208'),
      nutrient(208, 544, 'kJ'),
    ],
  };
  assert.equal(convertUsda([kj]).foods.length, 0);
});

test('USDA conversion converts units, picks a readable serving, and handles branded foods', () => {
  const branded = {
    fdcId: 9,
    description: 'CHOCOLATE BAR WITH NUTS',
    brandOwner: 'Acme Foods',
    gtinUpc: '4006381333931',
    servingSize: 45,
    servingSizeUnit: 'g',
    householdServingFullText: '1 bar',
    foodNutrients: [
      nutrient(208, 540, 'kcal'),
      nutrient(203, 8),
      nutrient(204, 30),
      nutrient(205, 55),
      nutrient(307, 0.2, 'g'),
    ],
  };
  const { foods } = convertUsda({ BrandedFoods: [branded] });
  assert.deepEqual(foods[0], {
    source: 'usda',
    externalId: 'fdc:9',
    name: 'Chocolate Bar With Nuts',
    brand: 'Acme Foods',
    barcode: '4006381333931',
    servingG: 45,
    servingLabel: '1 bar',
    calories100g: 540,
    protein100g: 8,
    fat100g: 30,
    carb100g: 55,
    sodiumMg100g: 200,
  });
  const portion = {
    ...usdaRice,
    fdcId: 10,
    foodPortions: [{ portionDescription: '1 medium', gramWeight: 118.4 }],
  };
  assert.equal(convertUsda([portion]).foods[0].servingLabel, '1 medium');
  const withUnit = {
    ...usdaRice,
    fdcId: 11,
    foodPortions: [{ amount: 2, measureUnit: { name: 'slice' }, modifier: 'thin', gramWeight: 40 }],
  };
  assert.equal(convertUsda([withUnit]).foods[0].servingLabel, '2 slice thin');
  const noPortion = convertUsda([{ ...usdaRice, fdcId: 12, foodPortions: [] }]).foods[0];
  assert.ok(!('servingG' in noPortion));
});

test('CSV parsing handles quotes, commas, new lines inside quotes, BOMs and blank lines', () => {
  const text = '﻿a,b,c\r\n1,"x, y",3\r\n\r\n"he said ""hi""","line\nbreak",\n';
  assert.deepEqual(parseCsv(text), [
    ['a', 'b', 'c'],
    ['1', 'x, y', '3'],
    ['he said "hi"', 'line\nbreak', ''],
  ]);
});

test('CSV conversion turns columns into typed fields and reports rows with bad numbers', () => {
  const csv = [
    'externalId,name,calories100g,protein100g,carb100g,fat100g,servingG,dishId,aliases,source',
    'safoods:1,"Pap, stiff",96,2.1,20.5,0.4,250,pap,"mealie pap; putu",curated',
    'safoods:2,Bad row,lots,1,1,1,,,,curated',
    'safoods:3,Defaults to source,100,1,1,1,,,,',
  ].join('\n');
  const { foods, skipped } = convertCsv(csv, { source: 'curated' });
  assert.equal(foods.length, 2);
  assert.deepEqual(foods[0], {
    source: 'curated',
    externalId: 'safoods:1',
    name: 'Pap, stiff',
    calories100g: 96,
    protein100g: 2.1,
    carb100g: 20.5,
    fat100g: 0.4,
    servingG: 250,
    dishId: 'pap',
    aliases: ['mealie pap', 'putu'],
  });
  assert.equal(foods[1].source, 'curated');
  assert.deepEqual(skipped, [{ id: 'safoods:2', reason: 'calories100g is not a number' }]);
  assert.deepEqual(convertCsv(''), { foods: [], skipped: [] });
});

test('JSON conversion accepts a list or an object and applies defaults without overriding', () => {
  assert.deepEqual(convertJson([{ name: 'a' }], { source: 'curated' }).foods, [
    { source: 'curated', name: 'a' },
  ]);
  assert.deepEqual(convertJson({ foods: [{ name: 'a', source: 'usda' }] }, { source: 'curated' }).foods, [
    { source: 'usda', name: 'a' },
  ]);
  assert.deepEqual(convertJson({}).foods, []);
});

test('foods are sent 100 at a time, results are added up, and positions are reported across calls', async () => {
  assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  const calls = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, key: init.headers['x-admin-key'], n: body.foods.length, dryRun: body.dryRun });
    return Response.json({
      created: body.foods.length - 1,
      updated: 0,
      warnings: [{}],
      dryRun: body.dryRun,
      rejected: [{ index: 0, externalId: 'x', reason: 'because' }],
    });
  };
  const foods = Array.from({ length: 230 }, (_, i) => ({ externalId: String(i) }));
  const lines = [];
  const total = await sendFoods(foods, {
    base: 'https://api.example.com/',
    key: 'k',
    dryRun: true,
    fetcher,
    log: (l) => lines.push(l),
  });
  assert.deepEqual(
    calls.map((c) => c.n),
    [100, 100, 30],
  );
  assert.equal(calls[0].url, 'https://api.example.com/v1/admin/foods/import');
  assert.ok(calls.every((c) => c.key === 'k' && c.dryRun === true));
  assert.equal(total.created, 227);
  assert.equal(total.warnings, 3);
  assert.deepEqual(
    total.rejected.map((r) => r.index),
    [0, 100, 200],
  );
  assert.equal(lines.length, 3);
});

test('a failed call is counted and the rest still go', async () => {
  let n = 0;
  const fetcher = async () =>
    ++n === 1
      ? new Response('nope', { status: 500 })
      : Response.json({ created: 1, updated: 0, warnings: [], rejected: [] });
  const total = await sendFoods(
    Array.from({ length: 150 }, () => ({})),
    { base: 'https://x', key: 'k', fetcher, log: () => {} },
  );
  assert.equal(total.failedCalls, 1);
  assert.equal(total.created, 1);
});

test('foods wait out the admin rate limit instead of losing a batch', async () => {
  const answers = [
    new Response('{}', { status: 429, headers: { 'retry-after': '7' } }),
    new Response(JSON.stringify({ created: 2, updated: 0, rejected: [], warnings: [] })),
  ];
  const waits = [];
  const lines = [];
  const total = await sendFoods([{ a: 1 }, { a: 2 }], {
    base: 'https://api.example.org',
    key: 'k',
    fetcher: async () => answers.shift(),
    log: (l) => lines.push(l),
    wait: async (ms) => waits.push(ms),
  });
  assert.deepEqual(waits, [7000]);
  assert.equal(total.created, 2);
  assert.equal(total.failedCalls, 0);
  assert.match(lines[0], /wait {2}7 s \(HTTP 429\)/);
});

test('import-foods can convert a file with no server, and refuses to run without arguments', () => {
  const dir = fileURLToPath(new URL('../tmp-foods-test/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(
      `${dir}in.json`,
      JSON.stringify({
        FoundationFoods: [usdaRice, { fdcId: 2, description: 'No data', foodNutrients: [] }],
      }),
    );
    const r = run('import-foods.mjs', [
      `${dir}in.json`,
      '--format',
      'usda',
      '--convert-only',
      '--out',
      `${dir}out.json`,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 foods ready, 1 skipped/);
    assert.match(r.stdout, /skipped 1: no calories100g, protein100g, fat100g, carb100g figure/);
    assert.equal(JSON.parse(readFileSync(`${dir}out.json`, 'utf8'))[0].externalId, 'fdc:168878');
    assert.notEqual(run('import-foods.mjs').status, 0);
    assert.notEqual(run('import-foods.mjs', [`${dir}in.json`, '--format', 'usda']).status, 0); // no API_BASE
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const offProduct = (over = {}, nutriments = {}) => ({
  code: '6001007200015',
  product_name: 'Ouma Buttermilk Rusks',
  brands: 'Ouma, Pioneer Foods',
  countries_tags: ['en:south-africa'],
  serving_size: '1 rusk (32 g)',
  serving_quantity: 32,
  nutriments: {
    'energy-kcal_100g': 430,
    proteins_100g: 8.5,
    carbohydrates_100g: 68,
    fat_100g: 13.4,
    fiber_100g: 3,
    sugars_100g: 20,
    sodium_100g: 0.35,
    ...nutriments,
  },
  ...over,
});

test('Open Food Facts: a product becomes a catalogue food keyed by its barcode', () => {
  assert.deepEqual(convertOffProduct(offProduct()), {
    food: {
      source: 'openfoodfacts',
      externalId: '6001007200015',
      barcode: '6001007200015',
      name: 'Ouma Buttermilk Rusks',
      brand: 'Ouma',
      servingG: 32,
      servingLabel: '1 rusk (32 g)',
      calories100g: 430,
      protein100g: 8.5,
      carb100g: 68,
      fat100g: 13.4,
      fiber100g: 3,
      sugar100g: 20,
      sodiumMg100g: 350,
    },
  });
  // UPC-A is stored as EAN-13, kJ is used when kcal is missing, strings are numbers too
  const upc = convertOffProduct(
    offProduct(
      { code: '600100005556', serving_quantity: '' },
      { 'energy-kcal_100g': undefined, energy_100g: '1799' },
    ),
  ).food;
  assert.equal(upc.barcode, '0600100005556');
  assert.equal(upc.calories100g, 429.97);
  assert.equal(upc.servingG, undefined);
});

test('Open Food Facts: nothing is assumed, and implausible numbers are left out', () => {
  const skip = (over, n) => convertOffProduct(offProduct(over, n)).skip;
  assert.equal(skip({ code: '6001007200016' }), 'no valid barcode');
  assert.equal(skip({ product_name: ' ', product_name_en: undefined }), 'no name');
  assert.equal(skip({}, { 'energy-kcal_100g': undefined }), 'no energy figure');
  assert.equal(skip({}, { proteins_100g: undefined }), 'no protein, carbohydrate or fat figure');
  assert.equal(skip({}, { 'energy-kcal_100g': 1800 }), 'more than 900 kcal per 100 g');
  assert.equal(
    skip({}, { carbohydrates_100g: 95 }),
    'protein, carbohydrate and fat add up to more than 100 g',
  );
  assert.equal(skip({}, { 'energy-kcal_100g': 150 }), 'energy does not match protein, carbohydrate and fat');
  // alcohol counts towards the energy, so a beer is kept
  const beer = convertOffProduct(
    offProduct(
      { product_name: 'Lager' },
      { 'energy-kcal_100g': 41, proteins_100g: 0.4, carbohydrates_100g: 3, fat_100g: 0, alcohol_100g: 4 },
    ),
  );
  assert.equal(beer.food?.calories100g, 41);
  // an out-of-range optional figure is dropped, not the food
  assert.equal(convertOffProduct(offProduct({}, { sugars_100g: 300 })).food.sugar100g, undefined);
});

test('Open Food Facts: reads only products sold in the chosen countries, from a gzipped file', async () => {
  const dir = fileURLToPath(new URL('../tmp-off-test/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  try {
    const lines = [
      offProduct(),
      offProduct({ code: '3017620422003', countries_tags: ['en:france'] }),
      offProduct(
        { code: '6009300001230', countries_tags: ['en:namibia', 'en:south-africa'] },
        { fat_100g: undefined },
      ),
      offProduct({ code: '6007000000010', countries_tags: ['en:namibia'] }),
      offProduct(), // listed twice
    ].map((p) => JSON.stringify(p));
    writeFileSync(`${dir}products.jsonl.gz`, gzipSync(lines.join('\n') + '\nnot json en:south-africa\n'));

    const za = await convertOffLines(readLines(`${dir}products.jsonl.gz`));
    assert.equal(za.scanned, 6);
    assert.equal(za.matched, 3);
    assert.deepEqual(
      za.foods.map((f) => f.barcode),
      ['6001007200015'],
    );
    assert.deepEqual(
      za.skipped.map((s) => s.reason),
      ['no protein, carbohydrate or fat figure', 'barcode listed twice'],
    );

    const two = await convertOffLines(readLines(`${dir}products.jsonl.gz`), {
      countries: ['en:south-africa', 'en:namibia'],
    });
    assert.deepEqual(
      two.foods.map((f) => f.barcode),
      ['6001007200015', '6007000000010'],
    );

    const r = run('import-foods.mjs', [
      `${dir}products.jsonl.gz`,
      '--format',
      'off',
      '--convert-only',
      '--out',
      `${dir}out.json`,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /read 6 products, 3 sold in en:south-africa/);
    assert.match(r.stdout, /1 foods ready, 2 skipped/);
    assert.equal(JSON.parse(readFileSync(`${dir}out.json`, 'utf8'))[0].name, 'Ouma Buttermilk Rusks');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Open Food Facts: the export can be streamed straight from a URL', async () => {
  const body = gzipSync(JSON.stringify(offProduct()) + '\n');
  let asked;
  const fetcher = async (url, init) => {
    asked = { url, ua: init.headers['user-agent'] };
    return new Response(body);
  };
  const out = await convertOffLines(readLines('https://example.org/products.jsonl.gz', fetcher));
  assert.equal(out.foods.length, 1);
  assert.equal(asked.url, 'https://example.org/products.jsonl.gz');
  assert.ok(asked.ua);
  await assert.rejects(
    convertOffLines(readLines('https://example.org/x.jsonl', async () => new Response('', { status: 404 }))),
    /HTTP 404/,
  );
});

// ---- export-training-data --------------------------------------------------------------------------------------

const contribution = (id, over = {}) => ({
  id,
  donor: 'donorAAAAAAAAAAAA',
  createdAt: 1_760_000_000_000,
  modelVersion: 'nutrition_v1',
  outcome: 'edited',
  kind: 'food',
  predictedCalories: 400,
  label: { calories: 520, massG: 260, fatG: 20, carbG: 50, proteinG: 25, edited: true },
  photoType: 'image/jpeg',
  ...over,
});

test('contributions: corrected photos train at low weight, accepted ones are left out unless asked for', () => {
  assert.deepEqual(classify(contribution('a')), { use: 'train', weight: 0.3 });
  const accepted = contribution('b', {
    outcome: 'saved',
    label: { calories: 400, massG: 200, fatG: 1, carbG: 1, proteinG: 1, edited: false },
  });
  assert.deepEqual(classify(accepted), { use: 'skip', why: 'accepted without change' });
  assert.deepEqual(classify(accepted, { includeAccepted: true }), { use: 'train', weight: 0.1 });
  assert.deepEqual(classify(contribution('c', { kind: 'not_food', label: null })), { use: 'not_food' });
  assert.deepEqual(classify(contribution('d', { kind: 'unlabelled', label: null })), {
    use: 'skip',
    why: 'no label',
  });
  assert.deepEqual(
    classify(
      contribution('e', {
        label: { calories: null, massG: null, fatG: 1, carbG: 1, proteinG: 1, edited: true },
      }),
    ),
    { use: 'skip', why: 'no usable number' },
  );
});

test('contributions: a person is always on one side of the train/test split', () => {
  assert.equal(isTestDonor('someone', 0.1), isTestDonor('someone', 0.1));
  const donors = Array.from({ length: 2000 }, (_, i) => `donor${i}`);
  const share = donors.filter((d) => isTestDonor(d, 0.1)).length / donors.length;
  assert.ok(share > 0.07 && share < 0.13, `share ${share}`);
  assert.equal(donors.filter((d) => isTestDonor(d, 0)).length, 0);
  assert.equal(donors.filter((d) => isTestDonor(d, 1)).length, donors.length);
});

test('contributions: rows leave unknown numbers blank and CSV quoting is safe', () => {
  const row = trainRow(
    contribution('a', {
      label: { calories: 520.04, massG: null, fatG: 20, carbG: 50, proteinG: 25, edited: true },
    }),
    'img/a.jpg',
    0.3,
    0,
  );
  assert.equal(row.calories, '520');
  assert.equal(row.mass, '');
  assert.equal(row.split, '');
  assert.equal(row.source, 'app-contrib');
  assert.equal(toCsv(['a', 'b'], [{ a: 'x,y', b: 'say "hi"' }]), 'a,b\n"x,y","say ""hi"""\n');
});

test('contributions: exports photos, a training index and a not-food list, and skips what is gone', async () => {
  const dir = fileURLToPath(new URL('../tmp-export-test/', import.meta.url));
  rmSync(dir, { recursive: true, force: true });
  const items = [
    contribution('keep1'),
    contribution('keep2', { donor: 'donorBBBBBBBBBBBB' }),
    contribution('neg1', { kind: 'not_food', outcome: 'not_food', label: null }),
    contribution('plain', { kind: 'unlabelled', outcome: 'discarded', label: null }),
    contribution('gone1'),
  ];
  const requested = [];
  const fetcher = async (url) => {
    requested.push(url);
    if (url.includes('/contributions?')) {
      return url.includes('cursor=NEXT')
        ? Response.json({ items: items.slice(3), nextCursor: null })
        : Response.json({ items: items.slice(0, 3), nextCursor: 'NEXT' });
    }
    if (url.includes('gone1')) return new Response('', { status: 404 });
    return new Response(new Uint8Array([0xff, 0xd8, 1, 2]), { headers: { 'content-type': 'image/jpeg' } });
  };
  try {
    const stats = await exportContributions({
      base: 'https://api.example.com',
      key: 'k',
      out: dir,
      fetcher,
      log: () => {},
    });
    assert.deepEqual(
      { ...stats, newest: 0 },
      { listed: 5, train: 2, notFood: 1, skipped: 1, downloaded: 3, failed: 1, newest: 0 },
    );
    assert.equal(stats.newest, 1_760_000_000_000);
    const index = readFileSync(`${dir}index.csv`, 'utf8').trim().split('\n');
    assert.equal(index[0], COLUMNS.join(','));
    assert.equal(index.length, 3);
    assert.match(index[1], /^img\/keep1\.jpg,520,260,20,50,25,0\.3,/);
    assert.deepEqual([...readFileSync(`${dir}img/keep1.jpg`)], [0xff, 0xd8, 1, 2]);
    assert.match(readFileSync(`${dir}not_food/index.csv`, 'utf8'), /img\/neg1\.jpg/);
    assert.ok(!existsSync(`${dir}img/gone1.jpg`));
    assert.ok(requested.every((u) => u.startsWith('https://api.example.com/v1/admin/training/')));
    // run again: photos already on disk are not downloaded a second time
    requested.length = 0;
    await exportContributions({
      base: 'https://api.example.com',
      key: 'k',
      out: dir,
      fetcher,
      log: () => {},
    });
    assert.equal(requested.filter((u) => u.endsWith('/photo')).length, 1); // only the unavailable one is retried
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('contributions: a failed listing stops the export with a clear error', async () => {
  const dir = fileURLToPath(new URL('../tmp-export-test2/', import.meta.url));
  try {
    await assert.rejects(
      exportContributions({
        base: 'https://x',
        key: 'bad',
        out: dir,
        fetcher: async () => new Response('no', { status: 401 }),
        log: () => {},
      }),
      /listing failed: HTTP 401/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('export-training-data refuses to run without its settings', () => {
  assert.notEqual(run('export-training-data.mjs').status, 0);
});

// ---- secret-scan -----------------------------------------------------------------------------------------------

// Built from pieces so this file does not contain the very things it looks for.
const fake = {
  cloudflare: 'cf' + 'ut_' + 'A1b2C3d4'.repeat(5),
  pem: '-----BEGIN ' + 'PRIVATE KEY-----',
  aws: 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP',
  github: 'gh' + 'p_' + 'a'.repeat(36),
  slack: 'https://hooks.slack.com/' + 'services/T0123ABC/B0123ABC/abcdefghijklmnop',
  discord: 'https://discord.com/api/' + 'webhooks/123456789012345678/abc-DEF_123',
  google: 'AI' + 'za' + 'A'.repeat(35),
  resend: 're' + '_' + 'Ab1'.repeat(10),
};

test('secret scan recognises the usual kinds of secret', () => {
  for (const [kind, value] of Object.entries(fake)) {
    const hits = scanText('x.txt', `const v = "${value}";`);
    assert.equal(hits.length > 0, true, `${kind} was not caught`);
  }
  assert.equal(scanText('x.ts', `CLOUDFLARE_API_TOKEN=${'a'.repeat(40)}`).length, 1);
  assert.equal(scanText('x.ts', `JWT_SECRET = "${'Ab3'.repeat(15)}"`).length, 1);
});

test('secret scan leaves ordinary text, placeholders and marked lines alone', () => {
  const fine = [
    'CLOUDFLARE_API_TOKEN=${{ secrets.CLOUDFLARE_API_TOKEN }}',
    'CLOUDFLARE_API_TOKEN: your-token-here',
    "JWT_SECRET: 'test-jwt-secret-0123456789-abcdefghijklmnop'",
    'const re_use = 5; // not a key',
    'The token is stored as a hash.',
    `JWT_SECRET = "${'Ab3'.repeat(15)}" // scan:allow`,
    'ADMIN_API_KEY=',
  ];
  for (const line of fine) assert.deepEqual(scanText('x.ts', line), [], line);
});

test('secret scan reports where it found something', () => {
  const hits = scanText('src/a.ts', `line one\nconst t = "${fake.github}";\n`);
  assert.deepEqual(hits, [{ file: 'src/a.ts', line: 2, what: 'GitHub token' }]);
});

test('secret scan finds a secret in a folder, skips node_modules and binaries, and flags an unignored .env', () => {
  const dir = fileURLToPath(new URL('../tmp-scan-test/', import.meta.url));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(`${dir}src`, { recursive: true });
  mkdirSync(`${dir}node_modules/pkg`, { recursive: true });
  try {
    writeFileSync(`${dir}src/ok.ts`, 'export const x = 1;\n');
    writeFileSync(`${dir}src/leak.ts`, `const key = "${fake.aws}";\n`);
    writeFileSync(`${dir}node_modules/pkg/bad.js`, `const key = "${fake.aws}";\n`);
    writeFileSync(`${dir}image.bin`, Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(fake.aws)]));
    writeFileSync(`${dir}.env`, 'A=1\n');
    const found = scanRepo(dir);
    assert.deepEqual(found.map((f) => `${f.file}:${f.what}`).sort(), [
      '.env:environment file that is not git-ignored',
      'src/leak.ts:AWS access key id',
    ]);
    writeFileSync(`${dir}.gitignore`, '.env\n');
    assert.deepEqual(
      scanRepo(dir).map((f) => f.file),
      ['src/leak.ts'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('this repository contains no secrets', () => {
  const found = scanRepo(root);
  assert.deepEqual(found, [], found.map((f) => `${f.file}:${f.line} ${f.what}`).join('\n'));
});

// ---- deploy settings added with the hardening work -------------------------------------------------------------

test('render-wrangler defaults the deploy-time settings, and takes them from the environment when given', () => {
  const out = fileURLToPath(new URL('../wrangler.rendered.jsonc', import.meta.url));
  const base = { D1_DATABASE_ID: 'abc', API_HOST: 'api.example.com' };
  let r = run('render-wrangler.mjs', [], base);
  assert.equal(r.status, 0, r.stderr);
  let text = readFileSync(out, 'utf8');
  assert.match(text, /"BILLING_PROVIDER": "mock"/);
  assert.match(text, /"REQUIRE_INTEGRITY": "false"/);
  assert.match(text, /"AI_DAILY_BUDGET": "20000"/);
  // GitHub passes an unset variable as an empty string: that must mean "default", not "empty"
  r = run('render-wrangler.mjs', [], { ...base, BILLING_PROVIDER: '', AI_DAILY_BUDGET: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(out, 'utf8'), /"BILLING_PROVIDER": "mock"/);
  r = run('render-wrangler.mjs', [], {
    ...base,
    BILLING_PROVIDER: 'google_play',
    REQUIRE_INTEGRITY: 'true',
    AI_DAILY_BUDGET: '500',
  });
  assert.equal(r.status, 0, r.stderr);
  text = readFileSync(out, 'utf8');
  assert.match(text, /"BILLING_PROVIDER": "google_play"/);
  assert.match(text, /"REQUIRE_INTEGRITY": "true"/);
  assert.match(text, /"AI_DAILY_BUDGET": "500"/);
  rmSync(out, { force: true });
});

test('sync-secrets passes the newer optional secrets and settings, and checks the rotation secret', () => {
  const good = {
    JWT_SECRET: 'j'.repeat(40),
    MEDIA_SIGNING_SECRET: 'm'.repeat(40),
    ADMIN_API_KEY: 'a'.repeat(30),
  };
  const ok = run('sync-secrets.mjs', ['stage', '--dry-run'], {
    ...good,
    JWT_SECRET_PREVIOUS: 'p'.repeat(40),
    RESEND_API_KEY: 'x',
    FCM_PROJECT_ID: 'my-project',
    STREAM_CUSTOMER_CODE: 'abcd1234',
    MIN_APP_VERSION: '1.2.0',
    ADMIN_ALLOWED_IPS: '203.0.113.0/24',
  });
  assert.equal(ok.status, 0, ok.stderr);
  for (const name of [
    'JWT_SECRET_PREVIOUS',
    'RESEND_API_KEY',
    'FCM_PROJECT_ID',
    'STREAM_CUSTOMER_CODE',
    'MIN_APP_VERSION',
    'ADMIN_ALLOWED_IPS',
  ])
    assert.match(ok.stdout, new RegExp(name));
  assert.ok(!ok.stdout.includes('p'.repeat(40)), 'values are never printed');
  const short = run('sync-secrets.mjs', ['stage', '--dry-run'], { ...good, JWT_SECRET_PREVIOUS: 'short' });
  assert.notEqual(short.status, 0);
  assert.match(short.stderr, /JWT_SECRET_PREVIOUS must be at least 32/);
  const same = run('sync-secrets.mjs', ['stage', '--dry-run'], {
    ...good,
    JWT_SECRET_PREVIOUS: good.JWT_SECRET,
  });
  assert.notEqual(same.status, 0);
  assert.match(same.stderr, /same as JWT_SECRET/);
});

test('both deploy workflows hand the Worker the same settings', () => {
  const read = (n) => readFileSync(new URL(`../.github/workflows/${n}`, import.meta.url), 'utf8');
  const names = (t) =>
    [...t.matchAll(/^\s{6}([A-Z0-9_]+): \$\{\{ (?:secrets|vars)\./gm)].map((m) => m[1]).sort();
  const stage = names(read('deploy-stage.yml'));
  assert.deepEqual(stage, names(read('deploy-production.yml')));
  const sync = readFileSync(new URL('./sync-secrets.mjs', import.meta.url), 'utf8');
  const render = readFileSync(new URL('./render-wrangler.mjs', import.meta.url), 'utf8');
  for (const name of stage) {
    if (['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'].includes(name)) continue;
    assert.ok(
      sync.includes(`'${name}'`) ||
        /(JWT_SECRET|MEDIA_SIGNING_SECRET|ADMIN_API_KEY)/.test(name) ||
        render.includes(name),
      `${name} reaches the Worker`,
    );
  }
});
