import { env } from 'cloudflare:workers';
import { createApp } from '../../src/app';
import type { Overrides } from '../../src/container';
import { FakeClock } from '../../src/core/time';
import { silentLogger } from '../../src/core/logger';
import { unlimited } from '../../src/core/rate-limiter';

export const T0 = Date.UTC(2026, 9, 21, 12, 0, 0); // 2026-10-21 12:00:00 UTC

export type TestApp = ReturnType<typeof makeApp>;

/** An app wired with a frozen clock, a silent logger and no rate limiting, plus a small request helper. */
export function makeApp(
  overrides: Overrides & { clock?: FakeClock } = {},
  configure?: (app: ReturnType<typeof createApp>) => void,
) {
  const clock = overrides.clock ?? new FakeClock(T0);
  const app = createApp({ logger: silentLogger, rateLimiter: unlimited, ...overrides, clock });
  configure?.(app); // add test-only routes here, before the first request builds the router
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

export type SessionBody = {
  accessToken: string;
  refreshToken: string;
  userId: string;
  isAnonymous: boolean;
  expiresIn: number;
  tokenType: string;
};

/** Create an anonymous account and return its session. */
export async function signUp(t: TestApp, deviceLabel = 'test phone'): Promise<SessionBody> {
  const res = await t.request('/v1/auth/anonymous', jsonInit('POST', { deviceLabel }));
  if (res.status !== 201) throw new Error(`signUp failed: ${res.status} ${await res.text()}`);
  return body<SessionBody>(res);
}

export const authed = (token: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  ...extra,
});
