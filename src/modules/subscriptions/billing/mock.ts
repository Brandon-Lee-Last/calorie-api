import { DAY, type Clock } from '../../../core/time';
import { isProductId, type ProductId } from '../../../config/plans';
import type { SubStatus } from '../entitlements';
import type { BillingProvider, ProviderSubscription } from './provider';

/**
 * A pretend store for development and testing. A token spells out what the "store" says about it:
 *
 *   mock_<product>_<state>[_anything]     e.g. mock_pro_monthly_active, mock_pro_yearly_trial_x7
 *
 * states: active, trial, canceled, grace, hold, expired, refunded.
 *
 * It must never grant access in production, where anyone could type such a token. See SubscriptionsService.
 */
const TOKEN =
  /^mock_(pro_monthly|pro_yearly)_(active|trial|canceled|grace|hold|expired|refunded)(?:_[A-Za-z0-9]{1,32})?$/;

const PERIOD_DAYS: Record<ProductId, number> = { pro_monthly: 30, pro_yearly: 365 };

export function parseMockToken(token: string): { productId: ProductId; state: string } | null {
  const m = TOKEN.exec(token);
  return m ? { productId: m[1] as ProductId, state: m[2]! } : null;
}

/** The state a mock token describes, at time `now`. The same token always describes the same situation. */
export function mockState(token: string, now: number): ProviderSubscription | null {
  const parsed = parseMockToken(token);
  if (!parsed) return null;
  const days = PERIOD_DAYS[parsed.productId];
  const base = {
    provider: 'mock' as const,
    externalId: token,
    productId: parsed.productId,
    environment: 'sandbox' as const,
    canceledAt: null,
    graceUntil: null,
  };
  const running = { startedAt: now - 5 * DAY, currentPeriodEnd: now - 5 * DAY + days * DAY };
  const byState: Record<string, Partial<ProviderSubscription> & { status: SubStatus; autoRenew: boolean }> = {
    active: { ...running, status: 'active', autoRenew: true },
    trial: { startedAt: now - 2 * DAY, currentPeriodEnd: now + 5 * DAY, status: 'trialing', autoRenew: true },
    canceled: { ...running, status: 'canceled', autoRenew: false, canceledAt: now - DAY },
    grace: {
      startedAt: now - days * DAY,
      currentPeriodEnd: now - 2 * DAY,
      status: 'in_grace',
      autoRenew: true,
      graceUntil: now + 3 * DAY,
    },
    hold: {
      startedAt: now - days * DAY - 5 * DAY,
      currentPeriodEnd: now - 6 * DAY,
      status: 'on_hold',
      autoRenew: true,
    },
    expired: {
      startedAt: now - 2 * days * DAY,
      currentPeriodEnd: now - days * DAY,
      status: 'expired',
      autoRenew: false,
    },
    refunded: {
      startedAt: now - 5 * DAY,
      currentPeriodEnd: now - 5 * DAY,
      status: 'refunded',
      autoRenew: false,
      canceledAt: now - 5 * DAY,
    },
  };
  return { ...base, ...byState[parsed.state]! } as ProviderSubscription;
}

export class MockBillingProvider implements BillingProvider {
  readonly name = 'mock' as const;
  constructor(private clock: Clock) {}

  async verify(input: { productId: string; purchaseToken: string }) {
    const parsed = parseMockToken(input.purchaseToken);
    if (!parsed || !isProductId(input.productId) || parsed.productId !== input.productId) return null;
    return mockState(input.purchaseToken, this.clock.now());
  }

  /** A mock purchase has no remote state to re-read; the stored row is the truth (the simulate endpoints edit it). */
  async refresh() {
    return null;
  }
}
