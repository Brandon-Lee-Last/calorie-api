import { HOUR } from '../../core/time';
import { PLANS, type Plan, type PlanId } from '../../config/plans';

export type SubStatus =
  'active' | 'trialing' | 'in_grace' | 'on_hold' | 'paused' | 'canceled' | 'expired' | 'refunded';

export type SubscriptionState = {
  status: SubStatus;
  currentPeriodEnd: number;
  graceUntil: number | null;
  autoRenew: boolean;
};

/**
 * Stores confirm a renewal a little after the period ends. Rather than lock a paying person out for those minutes, an
 * active subscription keeps working for this long past its recorded end.
 */
export const RENEWAL_LEEWAY_MS = 6 * HOUR;

/**
 * Does this subscription give Pro access right now?
 *
 *  active / trialing  yes, until the period ends (plus the renewal leeway)
 *  in_grace           yes, until the grace period ends (the store is retrying a failed payment)
 *  canceled           yes, until the period they already paid for ends
 *  on_hold, paused, expired, refunded: no
 */
export function grantsAccess(sub: SubscriptionState, now: number): boolean {
  switch (sub.status) {
    case 'active':
    case 'trialing':
      return now < sub.currentPeriodEnd + RENEWAL_LEEWAY_MS;
    case 'canceled':
      return now < sub.currentPeriodEnd;
    case 'in_grace':
      return sub.graceUntil !== null && now < sub.graceUntil;
    case 'on_hold':
    case 'paused':
    case 'expired':
    case 'refunded':
      return false;
  }
}

export type Entitlement = {
  plan: PlanId;
  status: SubStatus | 'none';
  /** When Pro access ends if nothing renews (null on the free plan). */
  expiresAt: number | null;
  willRenew: boolean;
  inGrace: boolean;
  isTrial: boolean;
};

const END_OF_ACCESS = (s: SubscriptionState) =>
  s.status === 'in_grace' ? (s.graceUntil ?? 0) : s.currentPeriodEnd;

/** The best state among a user's subscriptions: whichever grants access for longest wins. */
export function resolveEntitlement(subs: SubscriptionState[], now: number): Entitlement {
  const granting = subs
    .filter((s) => grantsAccess(s, now))
    .sort((a, b) => END_OF_ACCESS(b) - END_OF_ACCESS(a));
  const best = granting[0];
  if (!best) {
    // Report the most recent state so the app can say "your subscription expired" or "payment on hold".
    const latest = [...subs].sort((a, b) => b.currentPeriodEnd - a.currentPeriodEnd)[0];
    return {
      plan: 'free',
      status: latest?.status ?? 'none',
      expiresAt: null,
      willRenew: false,
      inGrace: false,
      isTrial: false,
    };
  }
  return {
    plan: 'pro',
    status: best.status,
    expiresAt: END_OF_ACCESS(best),
    willRenew: best.autoRenew && best.status !== 'canceled',
    inGrace: best.status === 'in_grace',
    isTrial: best.status === 'trialing',
  };
}

export const planFor = (e: Entitlement): Plan => PLANS[e.plan];
