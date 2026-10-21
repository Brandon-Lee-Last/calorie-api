#!/usr/bin/env node
// Pushes secrets from the process environment to the Worker with `wrangler secret bulk`.
// In CI the values come from GitHub *environment* secrets. Usage: node scripts/sync-secrets.mjs <stage|production>
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const envName = args.find((a) => !a.startsWith('--'));
if (!['stage', 'production'].includes(envName ?? '')) {
  console.error('usage: sync-secrets.mjs <stage|production> [--dry-run]');
  process.exit(1);
}

const REQUIRED = {
  JWT_SECRET: 32,
  MEDIA_SIGNING_SECRET: 32,
  ADMIN_API_KEY: 24,
};
const OPTIONAL = [
  'GOOGLE_PLAY_PACKAGE_NAME',
  'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON',
  'GOOGLE_PLAY_RTDN_AUDIENCE',
  'OFF_USER_AGENT',
];

const secrets = {};
const problems = [];
for (const [name, minLength] of Object.entries(REQUIRED)) {
  const value = process.env[name];
  if (!value) problems.push(`${name} is not set`);
  else if (value.length < minLength) problems.push(`${name} must be at least ${minLength} characters`);
  else secrets[name] = value;
}
for (const name of OPTIONAL) if (process.env[name]) secrets[name] = process.env[name];
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

if (dryRun) {
  console.log(
    `Would set ${Object.keys(secrets).length} secrets on ${envName}: ${Object.keys(secrets).join(', ')}`,
  );
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'secrets-'));
const file = join(dir, 'secrets.json');
try {
  writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  const r = spawnSync(
    'npx',
    ['wrangler', 'secret', 'bulk', file, '--config', 'wrangler.rendered.jsonc', '--env', envName],
    { stdio: 'inherit' },
  );
  process.exit(r.status ?? 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
