import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS as D1Migration[]);
