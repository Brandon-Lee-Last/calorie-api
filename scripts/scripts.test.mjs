// Tests for the deploy scripts. Run with: npm run test:scripts  (plain Node, no Cloudflare needed)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { planImport, runImport } from './import-content.mjs';
import { chunks, convertCsv, convertJson, convertUsda, parseCsv, sendFoods } from './import-foods.mjs';

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
    assert.ok(c.triggers.crons.length === 1, `${env} cron`);
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
