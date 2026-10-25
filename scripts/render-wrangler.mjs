#!/usr/bin/env node
// Writes wrangler.rendered.jsonc with the __PLACEHOLDERS__ in wrangler.jsonc replaced from environment variables.
// In CI these come from the deploy workflow and the GitHub *environment* variables (Settings > Environments > stage |
// production).
//
//   D1_DATABASE_ID       id of this environment's D1 database (printed by scripts/bootstrap-cloudflare.sh)
//   API_HOST             custom domain for the Worker (pango-api-stage.lightarch.io; set in the deploy workflow), or
//                        its free workers.dev address (calorie-api-stage.<your-subdomain>.workers.dev) when there is no
//                        domain on Cloudflare
//   GOOGLE_CLIENT_IDS    comma separated Google OAuth client ids (may be empty until Google sign-in is set up)
//   BILLING_PROVIDER     `mock` (default) or `google_play`
//   REQUIRE_INTEGRITY    `false` (default) or `true`: demand Play Integrity proof when an account is created
//   AI_DAILY_BUDGET      most AI calls the whole service makes in a day (default 20000)
//
// It refuses to render if a required value is missing, so a half-configured environment cannot deploy.
import { readFileSync, writeFileSync } from 'node:fs';

const required = ['D1_DATABASE_ID', 'API_HOST'];
const optional = {
  GOOGLE_CLIENT_IDS: '',
  BILLING_PROVIDER: 'mock',
  REQUIRE_INTEGRITY: 'false',
  AI_DAILY_BUDGET: '20000',
};

const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

let text = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
// A workers.dev address needs no domain: serve on it instead of routing a custom domain. With a custom domain the
// workers.dev address stays on too, so app builds made before the domain still reach the server.
const ROUTE = '"routes": [{ "pattern": "__API_HOST__", "custom_domain": true }],';
text = text.replaceAll(
  ROUTE,
  /\.workers\.dev$/i.test(process.env.API_HOST ?? '')
    ? '"workers_dev": true,'
    : `${ROUTE} "workers_dev": true,`,
);
const values = { ...optional, ...Object.fromEntries(required.map((k) => [k, process.env[k]])) };
// An unset GitHub variable arrives as an empty string: that means "use the default", except for the client ids, where empty is a real value.
for (const k of Object.keys(optional)) {
  const given = process.env[k];
  if (given !== undefined && (given !== '' || k === 'GOOGLE_CLIENT_IDS')) values[k] = given;
}
for (const [key, value] of Object.entries(values))
  text = text.replaceAll(`__${key}__`, String(value).replace(/"/g, ''));

const left = text.match(/__[A-Z0-9_]+__/g);
if (left) {
  console.error(`Unreplaced placeholders: ${[...new Set(left)].join(', ')}`);
  process.exit(1);
}
writeFileSync(new URL('../wrangler.rendered.jsonc', import.meta.url), text);
console.log('wrote wrangler.rendered.jsonc');
