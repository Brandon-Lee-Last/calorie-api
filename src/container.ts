import type { Bindings, Config } from './env';
import { getConfig } from './env';
import { createLogger, type Logger } from './core/logger';
import { D1RateLimiter, MemoryRateLimiter, type RateLimiter } from './core/rate-limiter';
import { hmacSha256Base64Url } from './core/crypto';
import { GoogleServiceAccountAuth } from './core/google-auth';
import {
  integrityMock,
  integrityOff,
  PlayIntegrityVerifier,
  type IntegrityVerifier,
} from './modules/integrity/integrity';
import { systemClock, type Clock } from './core/time';
import { AuthRepo } from './modules/auth/auth.repo';
import { AuthService } from './modules/auth/auth.service';
import { GoogleIdTokenVerifier, type GoogleVerifier } from './modules/auth/google';
import { TokenService } from './modules/auth/tokens';
import { BodyRepo } from './modules/body/body.repo';
import { BodyService } from './modules/body/body.service';
import { DiaryRepo } from './modules/diary/diary.repo';
import { DiaryService } from './modules/diary/diary.service';
import { MediaRepo } from './modules/media/media.repo';
import { MediaService } from './modules/media/media.service';
import { SessionsRepo } from './modules/workouts/sessions.repo';
import { SessionsService } from './modules/workouts/sessions.service';
import { WorkoutsRepo } from './modules/workouts/workouts.repo';
import { WorkoutsService } from './modules/workouts/workouts.service';
import { AdminRepo } from './modules/admin/admin.repo';
import { AdminService } from './modules/admin/admin.service';
import { AccountRepo } from './modules/account/account.repo';
import { AccountService } from './modules/account/account.service';
import { MaintenanceService } from './modules/maintenance/maintenance.service';
import { WorkersAiClient, type AiClient } from './modules/ai/ai.client';
import { AiService } from './modules/ai/ai.service';
import { InsightsService } from './modules/insights/insights.service';
import { ObjectStorage } from './modules/media/object-storage';
import { FoodsRepo } from './modules/foods/foods.repo';
import { FoodsService } from './modules/foods/foods.service';
import { OpenFoodFactsClient, type FoodLookup } from './modules/foods/off';
import { ScansRepo } from './modules/scans/scans.repo';
import { ScansService } from './modules/scans/scans.service';
import { SyncService } from './modules/sync/sync.service';
import { GooglePlayBillingProvider } from './modules/subscriptions/billing/google-play';
import { MockBillingProvider } from './modules/subscriptions/billing/mock';
import type { BillingProvider } from './modules/subscriptions/billing/provider';
import { SubscriptionsRepo } from './modules/subscriptions/subscriptions.repo';
import { SubscriptionsService } from './modules/subscriptions/subscriptions.service';
import { UsageRepo } from './modules/usage/usage.repo';
import { UsersRepo } from './modules/users/users.repo';
import { UsersService } from './modules/users/users.service';

/** Things a test (or a future environment) can swap out. Everything else is built from the bindings. */
export interface Overrides {
  clock?: Clock;
  logger?: Logger;
  rateLimiter?: RateLimiter;
  /** The shared-database limiter used for limits that must hold (sign-in, account creation, AI cost). */
  strictLimiter?: RateLimiter;
  integrity?: IntegrityVerifier;
  fetcher?: typeof fetch;
  googleVerifier?: GoogleVerifier;
  foodLookup?: FoodLookup;
  billing?: BillingProvider;
  ai?: AiClient;
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

  get strictLimiter(): RateLimiter {
    return this.once(
      'strictLimiter',
      () => this.overrides.strictLimiter ?? new D1RateLimiter(this.db, this.clock),
    );
  }

  /** A stable, non-reversible stand-in for an IP address, so limits can be keyed on it without storing the address. */
  async hashIp(ip: string): Promise<string> {
    return (await hmacSha256Base64Url(this.config.JWT_SECRET, `ip:${ip}`)).slice(0, 22);
  }

  get googleServiceAccount(): GoogleServiceAccountAuth {
    return this.once(
      'gsa',
      () =>
        new GoogleServiceAccountAuth(
          this.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON,
          this.clock,
          this.overrides.fetcher,
        ),
    );
  }

  get integrity(): IntegrityVerifier {
    return this.once('integrity', () => {
      if (this.overrides.integrity) return this.overrides.integrity;
      if (!this.config.REQUIRE_INTEGRITY) return integrityOff;
      if (this.config.isProduction) {
        return new PlayIntegrityVerifier(
          this.googleServiceAccount,
          this.config.GOOGLE_PLAY_PACKAGE_NAME,
          this.config.JWT_SECRET,
          this.clock,
          this.overrides.fetcher,
        );
      }
      return integrityMock; // local and stage: a fixed token, so the app team can test the flow without Play
    });
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

  get body(): BodyService {
    return this.once('body', () => new BodyService(new BodyRepo(this.db), this.users, this.clock));
  }

  get storage(): ObjectStorage {
    return this.once('storage', () => new ObjectStorage(this.env.MEDIA));
  }

  get billing(): BillingProvider {
    return this.once(
      'billing',
      () =>
        this.overrides.billing ??
        (this.config.BILLING_PROVIDER === 'google_play'
          ? new GooglePlayBillingProvider()
          : new MockBillingProvider(this.clock)),
    );
  }

  get subscriptions(): SubscriptionsService {
    return this.once(
      'subscriptions',
      () =>
        new SubscriptionsService(
          new SubscriptionsRepo(this.db),
          new UsageRepo(this.db),
          new UsersRepo(this.db),
          this.billing,
          this.clock,
          { isProduction: this.config.isProduction, simulateEnabled: this.config.SIMULATE_ENABLED },
        ),
    );
  }

  get media(): MediaService {
    return this.once(
      'media',
      () =>
        new MediaService(
          new MediaRepo(this.db),
          this.storage,
          this.clock,
          this.config.MEDIA_SIGNING_SECRET,
          async (userId) => (await this.subscriptions.entitlement(userId)).plan,
        ),
    );
  }

  get workouts(): WorkoutsService {
    return this.once(
      'workouts',
      () =>
        new WorkoutsService(
          new WorkoutsRepo(this.db),
          async (userId) => (await this.subscriptions.entitlement(userId)).plan,
          this.clock,
        ),
    );
  }

  get sessions(): SessionsService {
    return this.once(
      'sessions',
      () =>
        new SessionsService(
          new SessionsRepo(this.db),
          new WorkoutsRepo(this.db),
          (userId, programId) => this.workouts.afterSession(userId, programId),
          this.clock,
        ),
    );
  }

  get admin(): AdminService {
    return this.once(
      'admin',
      () => new AdminService(new AdminRepo(this.db), new MediaRepo(this.db), this.storage, this.clock),
    );
  }

  get account(): AccountService {
    return this.once(
      'account',
      () =>
        new AccountService(new AccountRepo(this.db), this.storage, this.clock, (userId) =>
          this.subscriptions.entitlement(userId),
        ),
    );
  }

  get maintenance(): MaintenanceService {
    return this.once('maintenance', () => new MaintenanceService(this.db, this.clock, this.logger));
  }

  get aiClient(): AiClient {
    return this.once(
      'aiClient',
      () => this.overrides.ai ?? new WorkersAiClient(this.env.AI, this.config.AI_TEXT_MODEL),
    );
  }

  get ai(): AiService {
    return this.once('ai', () => new AiService(this.aiClient));
  }

  get insights(): InsightsService {
    return this.once(
      'insights',
      () =>
        new InsightsService(
          new DiaryRepo(this.db),
          new BodyRepo(this.db),
          new SessionsRepo(this.db),
          new UsersRepo(this.db),
          this.subscriptions,
          this.ai,
          this.clock,
        ),
    ); // fmt: skip
  }

  get diary(): DiaryService {
    return this.once(
      'diary',
      () =>
        new DiaryService(
          new DiaryRepo(this.db),
          this.storage,
          this.clock,
          async (userId) => (await this.subscriptions.limitsFor(userId)).mealPhotos,
        ),
    );
  }

  get foodLookup(): FoodLookup {
    return this.once(
      'foodLookup',
      () =>
        this.overrides.foodLookup ??
        new OpenFoodFactsClient(
          this.config.OFF_USER_AGENT ?? 'CalorieApp/0.1 (https://github.com/Brandon-Lee-Last)',
        ),
    );
  }

  get foods(): FoodsService {
    return this.once('foods', () => new FoodsService(new FoodsRepo(this.db), this.foodLookup, this.clock));
  }

  get scans(): ScansService {
    return this.once(
      'scans',
      () =>
        new ScansService(new ScansRepo(this.db), this.storage, this.clock, (userId) =>
          this.subscriptions.countAdvisory(userId, 'scan'),
        ),
    );
  }

  get sync(): SyncService {
    return this.once(
      'sync',
      () => new SyncService(this.db, this.diary, this.body, this.foods, this.sessions, this.logger),
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
