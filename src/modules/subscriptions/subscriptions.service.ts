import {
  PLANS,
  PRODUCTS,
  isProductId,
  type PlanLimits,
  type UsageKey,
  LIMIT_FOR_KEY,
  type ProductId,
} from '../../config/plans';
import { badRequest, conflict, notConfigured, notFound, quotaExceeded } from '../../core/errors';
import { newId } from '../../core/ids';
import { randomToken } from '../../core/crypto';
import { DAY, localDateIn, type Clock } from '../../core/time';
import type { UsageRepo } from '../usage/usage.repo';
import type { UsersRepo } from '../users/users.repo';
import type { BillingProvider, ProviderSubscription } from './billing/provider';
import { mockState } from './billing/mock';
import { resolveEntitlement, type Entitlement, type SubscriptionState } from './entitlements';
import type { SubscriptionRow, SubscriptionsRepo } from './subscriptions.repo';

export type SimulateScenario = 'subscribe' | 'renew' | 'cancel' | 'expire' | 'grace' | 'hold' | 'refund';
export const SIMULATE_SCENARIOS: SimulateScenario[] = [
  'subscribe',
  'renew',
  'cancel',
  'expire',
  'grace',
  'hold',
  'refund',
];

const toState = (r: SubscriptionRow): SubscriptionState => ({
  status: r.status,
  currentPeriodEnd: r.current_period_end,
  graceUntil: r.grace_until,
  autoRenew: r.auto_renew === 1,
});

export const toSubscription = (r: SubscriptionRow) => ({
  id: r.id,
  provider: r.provider,
  productId: r.product_id,
  status: r.status,
  autoRenew: r.auto_renew === 1,
  startedAt: r.started_at,
  currentPeriodEnd: r.current_period_end,
  graceUntil: r.grace_until,
  canceledAt: r.canceled_at,
  environment: r.environment,
}); // fmt: skip

export class SubscriptionsService {
  constructor(
    private repo: SubscriptionsRepo,
    private usageRepo: UsageRepo,
    private usersRepo: UsersRepo,
    private billing: BillingProvider,
    private clock: Clock,
    private opts: { isProduction: boolean; simulateEnabled: boolean },
  ) {}

  // ---- entitlements and quotas ---------------------------------------------------------------------------------

  async entitlement(userId: string): Promise<Entitlement> {
    return resolveEntitlement((await this.repo.listForUser(userId)).map(toState), this.clock.now());
  }

  async limitsFor(userId: string): Promise<PlanLimits> {
    return PLANS[(await this.entitlement(userId)).plan].limits;
  }

  /** The local calendar date in the user's timezone, which is the period usage is counted over. */
  async today(userId: string): Promise<string> {
    const tz = (await this.usersRepo.getProfile(userId))?.timezone ?? 'UTC';
    return localDateIn(tz, this.clock.now());
  }

  async summary(userId: string) {
    const entitlement = await this.entitlement(userId);
    const plan = PLANS[entitlement.plan];
    const period = await this.today(userId);
    const used = await this.usageRepo.forPeriod(userId, period);
    return {
      ...entitlement,
      limits: plan.limits,
      features: plan.features,
      usage: { date: period, scans: used.scan ?? 0, aiText: used.ai_text ?? 0 },
    };
  }

  /** Spend one unit of a daily allowance, or fail with 429 `quota_exceeded`. Enforced for server-side work only. */
  async consume(userId: string, key: UsageKey): Promise<{ used: number; limit: number }> {
    const limit = (await this.limitsFor(userId))[LIMIT_FOR_KEY[key]];
    const used = await this.usageRepo.incrementWithin(userId, key, await this.today(userId), limit);
    if (used === null) throw quotaExceeded(key, limit);
    return { used, limit };
  }

  /** Hand back one unit of an allowance, for example after the AI service failed. */
  async refund(userId: string, key: UsageKey): Promise<void> {
    await this.usageRepo.remove(userId, key, await this.today(userId));
  }

  /** Count something that the app, not the server, enforces (photo scans run on the phone). */
  async countAdvisory(userId: string, key: UsageKey): Promise<void> {
    await this.usageRepo.add(userId, key, await this.today(userId));
  }

  // ---- subscriptions -------------------------------------------------------------------------------------------

  products() {
    return PRODUCTS.map((p) => ({ id: p.id, plan: p.plan, period: p.period, trialDays: p.trialDays }));
  }

  async current(userId: string) {
    const rows = await this.repo.listForUser(userId);
    return {
      subscription: rows[0] ? toSubscription(rows[0]) : null,
      entitlement: await this.summary(userId),
      products: this.products(),
    };
  }

  private assertProviderUsable() {
    // A pretend store would let anyone type a token and be Pro. In production it is switched off until a real store is set up.
    if (this.billing.name === 'mock' && this.opts.isProduction) throw notConfigured('Billing');
  }

  /** Check a purchase the app just made with the store, and attach it to this account. */
  async verify(userId: string, input: { productId: string; purchaseToken: string }) {
    this.assertProviderUsable();
    const state = await this.billing.verify(input);
    if (!state)
      throw badRequest('The store does not recognise this purchase', { reason: 'purchase_not_found' });
    await this.store(userId, state);
    return this.current(userId);
  }

  /** "Restore purchases": re-read the store's view of everything this account bought. */
  async restore(userId: string) {
    this.assertProviderUsable();
    for (const row of await this.repo.listForUser(userId)) {
      if (row.provider !== this.billing.name) continue;
      const fresh = await this.billing.refresh(row.external_id, row.product_id);
      if (fresh) await this.repo.applyState(row.id, fresh, this.clock.now());
    }
    return this.current(userId);
  }

  private async store(userId: string, state: ProviderSubscription): Promise<SubscriptionRow> {
    const now = this.clock.now();
    const existing = await this.repo.findByExternal(state.provider, state.externalId);
    if (existing && existing.user_id !== userId) {
      throw conflict('This purchase already belongs to another account', {
        reason: 'purchase_belongs_to_another_account',
      });
    }
    if (existing) await this.repo.applyState(existing.id, state, now);
    else await this.repo.insert(newId(now), userId, state, now);
    return (await this.repo.findByExternal(state.provider, state.externalId))!;
  }

  // ---- simulation (development and stage only) -----------------------------------------------------------------

  /** Drive the mock store: start a subscription, or move the latest one through its life. */
  async simulate(userId: string, scenario: SimulateScenario, productId: string = 'pro_monthly') {
    if (!this.opts.simulateEnabled || this.opts.isProduction || this.billing.name !== 'mock')
      throw notFound('Route');
    const now = this.clock.now();

    if (scenario === 'subscribe') {
      if (!isProductId(productId)) throw badRequest('Unknown product', { productId });
      const token = `mock_${productId}_active_${randomToken(6).replace(/[^A-Za-z0-9]/g, 'x')}`;
      await this.store(userId, mockState(token, now)!);
      return this.current(userId);
    }

    const row = (await this.repo.listForUser(userId)).find((r) => r.provider === 'mock');
    if (!row) throw badRequest('Start a subscription first (scenario "subscribe")');
    const periodMs = (row.product_id as ProductId) === 'pro_yearly' ? 365 * DAY : 30 * DAY;
    const s: ProviderSubscription = {
      provider: 'mock',
      externalId: row.external_id,
      productId: row.product_id,
      status: row.status,
      autoRenew: row.auto_renew === 1,
      startedAt: row.started_at,
      currentPeriodEnd: row.current_period_end,
      graceUntil: row.grace_until,
      canceledAt: row.canceled_at,
      environment: row.environment,
    }; // fmt: skip
    switch (scenario) {
      case 'renew':
        Object.assign(s, {
          status: 'active',
          startedAt: now,
          currentPeriodEnd: now + periodMs,
          graceUntil: null,
          autoRenew: true,
          canceledAt: null,
        });
        break;
      case 'cancel':
        Object.assign(s, { status: 'canceled', autoRenew: false, canceledAt: now });
        break;
      case 'expire':
        Object.assign(s, {
          status: 'expired',
          autoRenew: false,
          currentPeriodEnd: now - 1000,
          graceUntil: null,
        });
        break;
      case 'grace':
        Object.assign(s, { status: 'in_grace', currentPeriodEnd: now - 1000, graceUntil: now + 3 * DAY });
        break;
      case 'hold':
        Object.assign(s, { status: 'on_hold', currentPeriodEnd: now - 1000, graceUntil: null });
        break;
      case 'refund':
        Object.assign(s, {
          status: 'refunded',
          autoRenew: false,
          canceledAt: now,
          currentPeriodEnd: now - 1000,
          graceUntil: null,
        });
        break;
    }
    await this.repo.applyState(row.id, s, now);
    return this.current(userId);
  }
}
