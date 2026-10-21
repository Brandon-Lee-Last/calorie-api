#!/usr/bin/env node
// Writes wrangler.rendered.jsonc with the __PLACEHOLDERS__ in wrangler.jsonc replaced from environment variables.
// In CI these come from the GitHub *environment* variables (Settings > Environments > stage | production).
//
//   D1_DATABASE_ID       id of this environment's D1 database (printed by scripts/bootstrap-cloudflare.sh)
//   API_HOST             custom domain for the Worker, e.g. api-stage.example.com
//   GOOGLE_CLIENT_IDS    comma separated Google OAuth client ids (may be empty until Google sign-in is set up)
//
// It refuses to render if a required value is missing, so a half-configured environment cannot deploy.
import { readFileSync, writeFileSync } from 'node:fs';

const required = ['D1_DATABASE_ID', 'API_HOST'];
const optional = { GOOGLE_CLIENT_IDS: '' };

const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

let text = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const values = { ...optional, ...Object.fromEntries(required.map((k) => [k, process.env[k]])) };
if (process.env.GOOGLE_CLIENT_IDS !== undefined) values.GOOGLE_CLIENT_IDS = process.env.GOOGLE_CLIENT_IDS;
for (const [key, value] of Object.entries(values))
  text = text.replaceAll(`__${key}__`, String(value).replace(/"/g, ''));

const left = text.match(/__[A-Z0-9_]+__/g);
if (left) {
  console.error(`Unreplaced placeholders: ${[...new Set(left)].join(', ')}`);
  process.exit(1);
}
writeFileSync(new URL('../wrangler.rendered.jsonc', import.meta.url), text);
console.log('wrote wrangler.rendered.jsonc');
