import { env } from 'cloudflare:workers';
import { createApp } from '../../src/app';
import type { Overrides } from '../../src/container';
import { FakeClock } from '../../src/core/time';
import { silentLogger } from '../../src/core/logger';
import { unlimited } from '../../src/core/rate-limiter';

export const T0 = Date.UTC(2026, 9, 21, 12, 0, 0); // 2026-10-21 12:00:00 UTC

export type TestApp = ReturnType<typeof makeApp>;

/** An app wired with a frozen clock, a silent logger and no rate limiting, plus a small request helper. */
export function makeApp(overrides: Overrides & { clock?: FakeClock } = {}) {
  const clock = overrides.clock ?? new FakeClock(T0);
  const app = createApp({ logger: silentLogger, rateLimiter: unlimited, ...overrides, clock });
  const request = (path: string, init?: RequestInit) => app.request(path, init, env);
  return { app, clock, env, request };
}

export async function body<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export function jsonInit(
  method: string,
  data?: unknown,
  token?: string,
  extra: Record<string, string> = {},
): RequestInit {
  return {
    method,
    headers: {
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  };
}
