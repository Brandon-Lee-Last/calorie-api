/**
 * Pango Points, invites and partner (gym) codes. One place, so changing a rule is one edit.
 *
 * The numbers are a product decision: starting points chosen so a free month takes real effort (roughly 50 foods
 * added, or 4 friends who stick), which keeps it a reward and not a way round paying.
 */
export const POINTS = {
  /** A new food added to the food list (with a barcode it helps everyone scanning that product). */
  food: 10,
  foodWithBarcode: 20,
  /** Foods that earn points per day; more can be added, they just earn nothing. */
  foodsPerDay: 5,
  /** The person who invited, and the friend who joined, once the friend has logged food on `referralDays` days. */
  invitedFriend: 200,
  joinedWithInvite: 100,
  referralDays: 3,
  /** Invites rewarded per inviter per calendar month (UTC). */
  referralsPerMonth: 10,
  /** What a month of Plus costs, and how long that month is. */
  monthCost: 1000,
  monthDays: 30,
} as const;

/** A friend's or a partner's code can be entered within this many days of making an account. */
export const CODE_WINDOW_DAYS = 30;

/** Partner defaults, used when an admin creates a partner without saying otherwise. */
export const PARTNER_DEFAULTS = { sharePct: 20, months: 12, welcomePoints: 200 } as const;

/**
 * What a Plus period costs in the shop, in cents (rand), to work out a partner's share. Google Play does not say what a
 * person paid, so these must match the prices set in the Play Console (PLUS_PRICES_CENTS overrides them).
 */
export const DEFAULT_PRICES_CENTS: Record<string, number> = { pro_monthly: 6999, pro_yearly: 59999 };
/** South African VAT, included in shop prices, and Google Play's service fee on subscriptions. */
export const VAT = 0.15;
export const STORE_FEE = 0.15;

/** A partner's share of one paid period: of the price less VAT and the store's fee. Pure. */
export function partnerEarningCents(grossCents: number, sharePct: number): number {
  return Math.round(((grossCents / (1 + VAT)) * (1 - STORE_FEE) * sharePct) / 100);
}
