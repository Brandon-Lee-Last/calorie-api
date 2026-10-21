import { describe, expect, it } from 'vitest';
import { DAY, HOUR } from '../../core/time';
import { RENEWAL_LEEWAY_MS, grantsAccess, resolveEntitlement, type SubscriptionState } from './entitlements';
import { MockBillingProvider, mockState, parseMockToken } from './billing/mock';
import { FakeClock } from '../../core/time';

const NOW = 1_800_000_000_000;
const sub = (over: Partial<SubscriptionState> = {}): SubscriptionState => ({
  status: 'active',
  currentPeriodEnd: NOW + 10 * DAY,
  graceUntil: null,
  autoRenew: true,
  ...over,
}); // fmt: skip

describe('grantsAccess', () => {
  it.each([
    ['active, mid-period', sub(), true],
    ['active, a moment before the end', sub({ currentPeriodEnd: NOW + 1 }), true],
    ['active, just past the end (renewal not confirmed yet)', sub({ currentPeriodEnd: NOW - 1 }), true],
    ['active, past the end by the leeway', sub({ currentPeriodEnd: NOW - RENEWAL_LEEWAY_MS }), false],
    ['active, long past the end', sub({ currentPeriodEnd: NOW - 3 * DAY }), false],
    ['trialing, running', sub({ status: 'trialing' }), true],
    ['trialing, finished', sub({ status: 'trialing', currentPeriodEnd: NOW - DAY }), false],
    ['canceled but paid through', sub({ status: 'canceled', autoRenew: false }), true],
    [
      'canceled and the paid period is over',
      sub({ status: 'canceled', autoRenew: false, currentPeriodEnd: NOW - 1 }),
      false,
    ],
    ['canceled gets no renewal leeway', sub({ status: 'canceled', currentPeriodEnd: NOW }), false],
    [
      'in grace, grace running',
      sub({ status: 'in_grace', currentPeriodEnd: NOW - DAY, graceUntil: NOW + DAY }),
      true,
    ],
    [
      'in grace, grace over',
      sub({ status: 'in_grace', currentPeriodEnd: NOW - 5 * DAY, graceUntil: NOW - 1 }),
      false,
    ],
    ['in grace with no end recorded', sub({ status: 'in_grace', graceUntil: null }), false],
    ['on hold', sub({ status: 'on_hold' }), false],
    ['paused', sub({ status: 'paused' }), false],
    ['expired', sub({ status: 'expired' }), false],
    ['refunded', sub({ status: 'refunded' }), false],
  ])('%s -> %s', (_name, s, expected) => {
    expect(grantsAccess(s, NOW)).toBe(expected);
  });
});

describe('resolveEntitlement', () => {
  it('is free with no subscriptions', () => {
    expect(resolveEntitlement([], NOW)).toEqual({
      plan: 'free',
      status: 'none',
      expiresAt: null,
      willRenew: false,
      inGrace: false,
      isTrial: false,
    });
  });
  it('is pro for an active subscription and reports when it ends and whether it renews', () => {
    expect(resolveEntitlement([sub()], NOW)).toEqual({
      plan: 'pro',
      status: 'active',
      expiresAt: NOW + 10 * DAY,
      willRenew: true,
      inGrace: false,
      isTrial: false,
    });
  });
  it('flags trials, grace periods and cancellations', () => {
    expect(resolveEntitlement([sub({ status: 'trialing' })], NOW)).toMatchObject({
      plan: 'pro',
      isTrial: true,
    });
    const grace = resolveEntitlement(
      [sub({ status: 'in_grace', currentPeriodEnd: NOW - DAY, graceUntil: NOW + 2 * DAY })],
      NOW,
    );
    expect(grace).toMatchObject({ plan: 'pro', inGrace: true, expiresAt: NOW + 2 * DAY });
    expect(resolveEntitlement([sub({ status: 'canceled', autoRenew: false })], NOW)).toMatchObject({
      plan: 'pro',
      willRenew: false,
    });
  });
  it('picks the subscription that lasts longest when there are several', () => {
    const e = resolveEntitlement(
      [
        sub({ currentPeriodEnd: NOW + 2 * DAY }),
        sub({ currentPeriodEnd: NOW + 20 * DAY }),
        sub({ status: 'expired' }),
      ],
      NOW,
    );
    expect(e.expiresAt).toBe(NOW + 20 * DAY);
  });
  it('explains why access ended by reporting the most recent state', () => {
    const e = resolveEntitlement(
      [
        sub({ status: 'expired', currentPeriodEnd: NOW - 40 * DAY }),
        sub({ status: 'on_hold', currentPeriodEnd: NOW - 2 * DAY }),
      ],
      NOW,
    );
    expect(e).toMatchObject({ plan: 'free', status: 'on_hold', expiresAt: null });
  });
  it('access ends when time passes', () => {
    const s = sub({ currentPeriodEnd: NOW + HOUR });
    expect(resolveEntitlement([s], NOW).plan).toBe('pro');
    expect(resolveEntitlement([s], NOW + HOUR + RENEWAL_LEEWAY_MS).plan).toBe('free');
  });
});

describe('mock store', () => {
  it('understands its token format', () => {
    expect(parseMockToken('mock_pro_monthly_active')).toEqual({ productId: 'pro_monthly', state: 'active' });
    expect(parseMockToken('mock_pro_yearly_trial_x7')).toEqual({ productId: 'pro_yearly', state: 'trial' });
    for (const bad of [
      '',
      'mock_pro_weekly_active',
      'mock_pro_monthly_nope',
      'real_token_123',
      'mock_pro_monthly_active_',
      'mock_pro_monthly_active_bad token',
    ]) {
      expect(parseMockToken(bad), bad).toBeNull();
    }
  });
  it.each([
    ['active', 'pro', 'active'],
    ['trial', 'pro', 'trialing'],
    ['canceled', 'pro', 'canceled'],
    ['grace', 'pro', 'in_grace'],
    ['hold', 'free', 'on_hold'],
    ['expired', 'free', 'expired'],
    ['refunded', 'free', 'refunded'],
  ])('a %s token gives the %s plan (status %s)', (state, plan, status) => {
    const s = mockState(`mock_pro_monthly_${state}`, NOW)!;
    expect(s.status).toBe(status);
    expect(
      resolveEntitlement(
        [
          {
            status: s.status,
            currentPeriodEnd: s.currentPeriodEnd,
            graceUntil: s.graceUntil,
            autoRenew: s.autoRenew,
          },
        ],
        NOW,
      ).plan,
    ).toBe(plan);
  });
  it('verifies only when the token matches the product asked for', async () => {
    const store = new MockBillingProvider(new FakeClock(NOW));
    expect(
      await store.verify({ productId: 'pro_monthly', purchaseToken: 'mock_pro_monthly_active' }),
    ).toMatchObject({ provider: 'mock', externalId: 'mock_pro_monthly_active' });
    expect(
      await store.verify({ productId: 'pro_yearly', purchaseToken: 'mock_pro_monthly_active' }),
    ).toBeNull();
    expect(await store.verify({ productId: 'pro_monthly', purchaseToken: 'nonsense' })).toBeNull();
    expect(await store.verify({ productId: 'gold', purchaseToken: 'mock_pro_monthly_active' })).toBeNull();
    expect(await store.refresh()).toBeNull();
  });
});
