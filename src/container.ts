import type { Bindings, Config } from './env';
import { getConfig } from './env';
import { createLogger, type Logger } from './core/logger';
import { MemoryRateLimiter, type RateLimiter } from './core/rate-limiter';
import { systemClock, type Clock } from './core/time';

/** Things a test (or a future environment) can swap out. Everything else is built from the bindings. */
export interface Overrides {
  clock?: Clock;
  logger?: Logger;
  rateLimiter?: RateLimiter;
}

/**
 * The per-request bag of collaborators. Services are built lazily and memoised, so a route that only needs the
 * database does not construct the billing or AI clients. Each phase of the build adds its services here.
 */
export class Container {
  readonly config: Config;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly rateLimiter: RateLimiter;

  constructor(
    readonly env: Bindings,
    overrides: Overrides = {},
    requestLogFields: Record<string, unknown> = {},
  ) {
    this.config = getConfig(env);
    this.clock = overrides.clock ?? systemClock;
    this.logger = (
      overrides.logger ?? createLogger({ level: this.config.ENVIRONMENT === 'local' ? 'debug' : 'info' })
    ).child({
      env: this.config.ENVIRONMENT,
      ...requestLogFields,
    });
    this.rateLimiter = overrides.rateLimiter ?? sharedLimiter(this.clock);
  }

  get db(): D1Database {
    return this.env.DB;
  }
}

let shared: MemoryRateLimiter | undefined;
function sharedLimiter(clock: Clock): RateLimiter {
  return (shared ??= new MemoryRateLimiter(clock));
}
