// Tests for the deploy scripts. Run with: npm run test:scripts  (plain Node, no Cloudflare needed)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { planImport, runImport } from './import-content.mjs';

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
