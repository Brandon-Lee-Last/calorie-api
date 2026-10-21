import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // Secrets for tests only. Real secrets come from GitHub environment secrets at deploy time.
          bindings: {
            TEST_MIGRATIONS: migrations,
            JWT_SECRET: 'test-jwt-secret-0123456789-abcdefghijklmnop',
            MEDIA_SIGNING_SECRET: 'test-media-secret-0123456789-abcdefghijklm',
            ADMIN_API_KEY: 'test-admin-api-key-0123456789',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
      coverage: {
        provider: 'istanbul' as const,
        include: ['src/**/*.ts'],
        exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/**/*.d.ts'],
        reporter: ['text-summary', 'text'] as ('text-summary' | 'text')[],
        // CI fails if coverage slips below these. They sit a little under today's numbers.
        thresholds: { statements: 95, lines: 96, functions: 95, branches: 85 },
      },
    },
  };
});
