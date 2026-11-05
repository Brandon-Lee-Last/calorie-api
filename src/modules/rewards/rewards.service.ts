import {
  CODE_WINDOW_DAYS,
  DEFAULT_PRICES_CENTS,
  PARTNER_DEFAULTS,
  POINTS,
  partnerEarningCents,
} from '../../config/rewards';
import { AppError, badRequest, conflict, notFound } from '../../core/errors';
import { newId } from '../../core/ids';
import { DAY, type Clock } from '../../core/time';
import type { Logger } from '../../core/logger';
import type { SubscriptionState } from '../subscriptions/entitlements';
import type { SubscriptionRow } from '../subscriptions/subscriptions.repo';
import type { LedgerReason, PartnerRow, RewardsRepo } from './rewards.repo';

/** Letters and digits that cannot be mistaken for each other when read out or typed (no 0/O, 1/I/L). */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** A code as typed: upper case, without spaces or dashes. */
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, '');
export const isPartnerCode = (code: string) => /^[A-Z0-9]{3,16}$/.test(code);

/** Whether a food's numbers hang together (energy close to 4 kcal a gram of protein and carbs, 9 of fat). Pure. */
export function plausibleFood(f: {
  calories100g: number;
  protein100g: number;
  carb100g: number;
  fat100g: number;
}): boolean {
  if (f.calories100g <= 0 || f.protein100g + f.carb100g + f.fat100g > 100) return false;
  const fromMacros = 4 * f.protein100g + 4 * f.carb100g + 9 * f.fat100g;
  return Math.abs(fromMacros - f.calories100g) <= Math.max(30, f.calories100g * 0.35);
}

const startOfMonthUtc = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

export class RewardsService {
  constructor(
    private repo: RewardsRepo,
    private clock: Clock,
    private logger: Logger,
    /** Until when a store subscription (not points) gives Plus, if it does. */
    private paidAccessUntil: (userId: string) => Promise<number | null>,
    private prices: Record<string, number> = DEFAULT_PRICES_CENTS,
    private random: () => number = Math.random,
  ) {}

  private ledger(userId: string, amount: number, reason: LedgerReason, ref: string) {
    const now = this.clock.now();
    return { id: newId(now), user_id: userId, amount, reason, ref, created_at: now };
  }

  /** Hooks must never break the write that called them: a failure is logged and the points are simply not given. */
  private async quietly(what: string, f: () => Promise<unknown>) {
    try {
      await f();
    } catch (e) {
      this.logger.error('rewards hook failed', { what, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ---- earning

  /** A food added to the food list: points if it is new, plausible, and under today's cap. */
  onFoodAdded(
    userId: string,
    food: {
      id: string;
      barcode: string | null;
      calories100g: number;
      protein100g: number;
      carb100g: number;
      fat100g: number;
    },
  ) {
    return this.quietly('food', async () => {
      if (!plausibleFood(food)) return;
      if ((await this.repo.countSince(userId, 'food', this.clock.now() - DAY)) >= POINTS.foodsPerDay) return;
      await this.repo.award(
        this.ledger(userId, food.barcode ? POINTS.foodWithBarcode : POINTS.food, 'food', food.id),
      );
    });
  }

  /** A food deleted again takes its points back, so adding and deleting earns nothing. */
  onFoodDeleted(userId: string, foodId: string) {
    return this.quietly('food deleted', async () => {
      const given = await this.repo.find(userId, 'food', foodId);
      if (given) await this.repo.award(this.ledger(userId, -given.amount, 'food_removed', foodId));
    });
  }

  /** After food is logged: an invited friend who has now logged on enough days earns both of them their points. */
  onDiaryLogged(userId: string) {
    return this.quietly('referral', async () => {
      const ref = await this.repo.referralOf(userId);
      if (!ref || ref.rewarded_at) return;
      if ((await this.repo.loggedDays(userId)) < POINTS.referralDays) return;
      if (!(await this.repo.markReferralRewarded(userId, this.clock.now()))) return;
      await this.repo.award(
        this.ledger(userId, POINTS.joinedWithInvite, 'joined_with_invite', ref.inviter_id),
      );
      // The inviter's monthly cap stops a farm of fake accounts paying out; the friend still gets theirs.
      if (
        (await this.repo.countSince(ref.inviter_id, 'invited_friend', startOfMonthUtc(this.clock.now()))) <
        POINTS.referralsPerMonth
      )
        await this.repo.award(this.ledger(ref.inviter_id, POINTS.invitedFriend, 'invited_friend', userId));
    });
  }

  // ---- partner earnings (called by subscriptions)

  /** A paid Plus period (not a free trial) of a partner's member earns the partner its share, once per period. */
  onSubscriptionStored(row: SubscriptionRow) {
    return this.quietly('partner earning', async () => {
      if (row.status === 'refunded')
        return void (await this.repo.reverseLatestEarning(row.id, this.clock.now()));
      if (row.status !== 'active' && row.status !== 'canceled') return;
      const partner = await this.repo.signupOf(row.user_id);
      if (!partner) return;
      const now = this.clock.now();
      if (partner.months > 0 && now > partner.joined_at + partner.months * 30 * DAY) return;
      const gross = this.prices[row.product_id];
      if (!gross) return;
      await this.repo.addEarning({
        id: newId(now),
        partner_id: partner.id,
        user_id: row.user_id,
        subscription_id: row.id,
        period_end: row.current_period_end,
        product_id: row.product_id,
        gross_cents: gross,
        earning_cents: partnerEarningCents(gross, partner.share_pct),
        created_at: now,
        reversed_at: null,
        paid_at: null,
      });
    });
  }

  onRefunded(subscriptionId: string) {
    return this.quietly('partner refund', () =>
      this.repo.reverseLatestEarning(subscriptionId, this.clock.now()),
    );
  }

  /** Plus months bought with points, as subscription states for working out access. */
  async grantStates(userId: string): Promise<SubscriptionState[]> {
    const now = this.clock.now();
    return (await this.repo.grants(userId))
      .filter((g) => g.starts_at <= now)
      .map((g) => ({
        status: 'active' as const,
        currentPeriodEnd: g.ends_at,
        graceUntil: null,
        autoRenew: false,
      }));
  }

  // ---- the person's view

  private async inviteCode(userId: string): Promise<string> {
    const have = await this.repo.inviteCodeOf(userId);
    if (have) return have.code;
    for (let attempt = 0; attempt < 8; attempt++) {
      const code =
        'P' + Array.from({ length: 6 }, () => ALPHABET[Math.floor(this.random() * ALPHABET.length)]).join('');
      if (await this.repo.claimInviteCode(userId, code, this.clock.now())) return code;
      const mine = await this.repo.inviteCodeOf(userId); // made by a request running at the same time
      if (mine) return mine.code;
    }
    throw conflict('Could not make an invite code; try again');
  }

  async summary(userId: string) {
    const now = this.clock.now();
    const [points, inviteCode, history, referral, partner, created, grants, counts] = await Promise.all([
      this.repo.balance(userId),
      this.inviteCode(userId),
      this.repo.history(userId, 30),
      this.repo.referralOf(userId),
      this.repo.signupOf(userId),
      this.repo.accountCreatedAt(userId),
      this.repo.grants(userId),
      this.repo.referralCounts(userId),
    ]);
    const codeUntil = (created?.created_at ?? now) + CODE_WINDOW_DAYS * DAY;
    const lastGrant = grants.at(-1);
    return {
      points,
      monthCost: POINTS.monthCost,
      monthDays: POINTS.monthDays,
      inviteCode,
      codeEntry: {
        open: now < codeUntil && (!referral || !partner),
        until: codeUntil,
        usedInvite: !!referral,
        partner: partner ? { name: partner.name } : null,
      },
      invites: counts,
      plusFromPointsUntil: lastGrant && lastGrant.ends_at > now ? lastGrant.ends_at : null,
      rules: {
        food: POINTS.food,
        foodWithBarcode: POINTS.foodWithBarcode,
        foodsPerDay: POINTS.foodsPerDay,
        invitedFriend: POINTS.invitedFriend,
        joinedWithInvite: POINTS.joinedWithInvite,
        referralDays: POINTS.referralDays,
      },
      history: history.map((h) => ({ amount: h.amount, reason: h.reason, at: h.created_at })),
    };
  }

  /** A friend's invite code or a partner's code, entered within the first weeks of an account. */
  async enterCode(userId: string, typed: string) {
    const code = normalizeCode(typed);
    const now = this.clock.now();
    const created = await this.repo.accountCreatedAt(userId);
    if (created && now > created.created_at + CODE_WINDOW_DAYS * DAY)
      throw badRequest(`Codes can be entered in the first ${CODE_WINDOW_DAYS} days of an account`, {
        reason: 'code_window_closed',
      });

    const partner = await this.repo.partnerByCode(code);
    if (partner) {
      if (!partner.active) throw badRequest('That code is no longer running', { reason: 'code_inactive' });
      if (!(await this.repo.addSignup(userId, partner.id, now)))
        throw conflict('You have already joined with a partner code', { reason: 'partner_already_set' });
      if (partner.welcome_points > 0)
        await this.repo.award(this.ledger(userId, partner.welcome_points, 'partner_welcome', partner.id));
      return { kind: 'partner' as const, name: partner.name, points: partner.welcome_points };
    }

    const owner = await this.repo.ownerOfInviteCode(code);
    if (!owner)
      throw new AppError(404, 'not_found', 'No code like that: check the spelling', {
        reason: 'unknown_code',
      });
    if (owner.user_id === userId)
      throw badRequest('That is your own code: share it with friends instead', { reason: 'own_code' });
    if (!(await this.repo.addReferral(userId, owner.user_id, now)))
      throw conflict('You have already used a friend’s code', { reason: 'invite_already_used' });
    // Already logging? Their days count straight away.
    await this.onDiaryLogged(userId);
    return { kind: 'invite' as const, name: null, points: POINTS.joinedWithInvite };
  }

  /** Spends points on a month of Plus, starting now or when the last one ends. Not while paying in the shop. */
  async redeem(userId: string) {
    const now = this.clock.now();
    const paid = await this.paidAccessUntil(userId);
    if (paid && paid > now)
      throw conflict('You already have Plus from Google Play; keep your points for later', {
        reason: 'paid_plus_active',
      });
    const grantId = newId(now);
    if (!(await this.repo.spend(this.ledger(userId, -POINTS.monthCost, 'redeemed', grantId))))
      throw conflict(`A month of Plus takes ${POINTS.monthCost} points`, { reason: 'not_enough_points' });
    const last = (await this.repo.grants(userId)).at(-1);
    const starts = Math.max(now, last?.ends_at ?? 0);
    const grant = {
      id: grantId,
      user_id: userId,
      starts_at: starts,
      ends_at: starts + POINTS.monthDays * DAY,
      points: POINTS.monthCost,
      created_at: now,
    };
    await this.repo.addGrant(grant);
    return { plusUntil: grant.ends_at, points: await this.repo.balance(userId) };
  }

  // ---- admin: partners

  async createPartner(input: {
    name: string;
    code: string;
    sharePct?: number;
    months?: number;
    welcomePoints?: number;
    contact?: string | null;
  }) {
    const code = normalizeCode(input.code);
    if (!isPartnerCode(code)) throw badRequest('A code is 3 to 16 letters and digits');
    if ((await this.repo.partnerByCode(code)) || (await this.repo.ownerOfInviteCode(code)))
      throw conflict('That code is taken');
    const row: PartnerRow = {
      id: newId(this.clock.now()),
      name: input.name,
      code,
      share_pct: input.sharePct ?? PARTNER_DEFAULTS.sharePct,
      months: input.months ?? PARTNER_DEFAULTS.months,
      welcome_points: input.welcomePoints ?? PARTNER_DEFAULTS.welcomePoints,
      contact: input.contact ?? null,
      active: 1,
      created_at: this.clock.now(),
    };
    await this.repo.addPartner(row);
    return toPartner({ ...row, members: 0, plus_members: 0, earned_cents: 0, owed_cents: 0 });
  }

  async updatePartner(
    id: string,
    patch: {
      name?: string;
      sharePct?: number;
      months?: number;
      welcomePoints?: number;
      contact?: string | null;
      active?: boolean;
    },
  ) {
    if (!(await this.repo.partner(id))) throw notFound('Partner');
    await this.repo.updatePartner(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.sharePct !== undefined ? { share_pct: patch.sharePct } : {}),
      ...(patch.months !== undefined ? { months: patch.months } : {}),
      ...(patch.welcomePoints !== undefined ? { welcome_points: patch.welcomePoints } : {}),
      ...(patch.contact !== undefined ? { contact: patch.contact } : {}),
      ...(patch.active !== undefined ? { active: patch.active ? 1 : 0 } : {}),
    });
    return (await this.listPartners()).find((p) => p.id === id)!;
  }

  async listPartners() {
    return (await this.repo.listPartners(this.clock.now())).map(toPartner);
  }

  /** A month's statement for one partner: who joined, every paid period and what it earned, and the totals. */
  async report(id: string, month: string) {
    const partner = await this.repo.partner(id);
    if (!partner) throw notFound('Partner');
    const [y, m] = month.split('-').map(Number);
    const from = Date.UTC(y!, m! - 1, 1);
    const to = Date.UTC(y!, m!, 1);
    const [rows, joined] = await Promise.all([
      this.repo.earnings(id, from, to),
      this.repo.signupsBetween(id, from, to),
    ]);
    const counted = rows.filter((r) => !r.reversed_at);
    return {
      partner: { id: partner.id, name: partner.name, code: partner.code, sharePct: partner.share_pct },
      month,
      joined,
      payments: rows.map((r) => ({
        at: r.created_at,
        productId: r.product_id,
        grossCents: r.gross_cents,
        earningCents: r.earning_cents,
        refunded: r.reversed_at !== null,
        paid: r.paid_at !== null,
      })),
      totalEarningCents: counted.reduce((s, r) => s + r.earning_cents, 0),
      unpaidCents: counted.filter((r) => !r.paid_at).reduce((s, r) => s + r.earning_cents, 0),
    };
  }

  async markPaid(id: string, until: number) {
    if (!(await this.repo.partner(id))) throw notFound('Partner');
    return this.repo.markPaid(id, until, this.clock.now());
  }
}

const toPartner = (
  p: PartnerRow & { members: number; plus_members: number; earned_cents: number; owed_cents: number },
) => ({
  id: p.id,
  name: p.name,
  code: p.code,
  sharePct: p.share_pct,
  months: p.months,
  welcomePoints: p.welcome_points,
  contact: p.contact,
  active: p.active === 1,
  createdAt: p.created_at,
  members: p.members,
  plusMembers: p.plus_members,
  earnedCents: p.earned_cents,
  owedCents: p.owed_cents,
});
