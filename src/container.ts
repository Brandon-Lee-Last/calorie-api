import type { Bindings, Config } from './env';
import { getConfig } from './env';
import { createLogger, type Logger } from './core/logger';
import { MemoryRateLimiter, type RateLimiter } from './core/rate-limiter';
import { systemClock, type Clock } from './core/time';
import { AuthRepo } from './modules/auth/auth.repo';
import { AuthService } from './modules/auth/auth.service';
import { GoogleIdTokenVerifier, type GoogleVerifier } from './modules/auth/google';
import { TokenService } from './modules/auth/tokens';
import { UsersRepo } from './modules/users/users.repo';
import { UsersService } from './modules/users/users.service';

/** Things a test (or a future environment) can swap out. Everything else is built from the bindings. */
export interface Overrides {
  clock?: Clock;
  logger?: Logger;
  rateLimiter?: RateLimiter;
  googleVerifier?: GoogleVerifier;
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
  private memo = new Map<string, unknown>();
  private overrides: Overrides;

  constructor(
    readonly env: Bindings,
    overrides: Overrides = {},
    requestLogFields: Record<string, unknown> = {},
  ) {
    this.overrides = overrides;
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

  private once<T>(key: string, make: () => T): T {
    if (!this.memo.has(key)) this.memo.set(key, make());
    return this.memo.get(key) as T;
  }

  get tokens(): TokenService {
    return this.once('tokens', () => new TokenService(this.config.JWT_SECRET, this.clock));
  }

  get googleVerifier(): GoogleVerifier {
    return this.once(
      'google',
      () =>
        this.overrides.googleVerifier ?? new GoogleIdTokenVerifier(this.config.GOOGLE_CLIENT_IDS, this.clock),
    );
  }

  get users(): UsersService {
    return this.once(
      'users',
      () => new UsersService(new UsersRepo(this.db), new AuthRepo(this.db), this.clock),
    );
  }

  get auth(): AuthService {
    return this.once(
      'auth',
      () => new AuthService(new AuthRepo(this.db), this.tokens, this.googleVerifier, this.clock),
    );
  }
}

let shared: MemoryRateLimiter | undefined;
function sharedLimiter(clock: Clock): RateLimiter {
  return (shared ??= new MemoryRateLimiter(clock));
}
