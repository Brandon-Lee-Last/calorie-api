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
// Set only when present. Secrets come from GitHub environment secrets, settings from environment variables; the Worker sees both
// the same way. Leaving one out does NOT remove it from the Worker: delete it there with `wrangler secret delete`.
const OPTIONAL = [
  'GOOGLE_PLAY_PACKAGE_NAME',
  'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON',
  'GOOGLE_PLAY_RTDN_AUDIENCE',
  'OFF_USER_AGENT',
  // secrets
  'JWT_SECRET_PREVIOUS',
  'RESEND_API_KEY',
  'FCM_SERVICE_ACCOUNT_JSON',
  'STREAM_SIGNING_KEY_PEM',
  'ALERT_WEBHOOK_URL',
  // settings
  'EMAIL_FROM',
  'FCM_PROJECT_ID',
  'STREAM_CUSTOMER_CODE',
  'STREAM_SIGNING_KEY_ID',
  'MIN_APP_VERSION',
  'LATEST_APP_VERSION',
  'STORE_URL',
  'PRIVACY_URL',
  'TERMS_URL',
  'SUPPORT_EMAIL',
  'ADMIN_ALLOWED_IPS',
  'CF_ACCESS_TEAM_DOMAIN',
  'CF_ACCESS_AUD',
  'GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT',
  'MAINTENANCE_MODE',
  'MAINTENANCE_MESSAGE',
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
if (secrets.JWT_SECRET_PREVIOUS && secrets.JWT_SECRET_PREVIOUS.length < 32)
  problems.push('JWT_SECRET_PREVIOUS must be at least 32 characters');
if (secrets.JWT_SECRET_PREVIOUS === secrets.JWT_SECRET)
  problems.push('JWT_SECRET_PREVIOUS is the same as JWT_SECRET: rotate by setting a NEW JWT_SECRET');
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
