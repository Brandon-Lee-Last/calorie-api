import { all, first, run } from '../../db/sql';

export type LedgerReason =
  | 'food'
  | 'food_removed'
  | 'invited_friend'
  | 'joined_with_invite'
  | 'partner_welcome'
  | 'redeemed'
  | 'adjustment';
export type LedgerRow = {
  id: string;
  user_id: string;
  amount: number;
  reason: LedgerReason;
  ref: string;
  created_at: number;
};
export type PartnerRow = {
  id: string;
  name: string;
  code: string;
  share_pct: number;
  months: number;
  welcome_points: number;
  contact: string | null;
  active: number;
  created_at: number;
};
export type ReferralRow = {
  invitee_id: string;
  inviter_id: string;
  created_at: number;
  rewarded_at: number | null;
};
export type GrantRow = {
  id: string;
  user_id: string;
  starts_at: number;
  ends_at: number;
  points: number;
  created_at: number;
};
export type EarningRow = {
  id: string;
  partner_id: string;
  user_id: string | null;
  subscription_id: string;
  period_end: number;
  product_id: string;
  gross_cents: number;
  earning_cents: number;
  created_at: number;
  reversed_at: number | null;
  paid_at: number | null;
};

export class RewardsRepo {
  constructor(private db: D1Database) {}

  // ---- points

  async balance(userId: string): Promise<number> {
    const row = await first<{ n: number | null }>(
      this.db.prepare('SELECT SUM(amount) AS n FROM points_ledger WHERE user_id = ?').bind(userId),
    );
    return row?.n ?? 0;
  }

  /** Adds a ledger row unless one with the same reason and ref exists. True when it was added. */
  async award(row: LedgerRow): Promise<boolean> {
    return (
      (await run(
        this.db
          .prepare(
            'INSERT OR IGNORE INTO points_ledger (id, user_id, amount, reason, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .bind(row.id, row.user_id, row.amount, row.reason, row.ref, row.created_at),
      )) === 1
    );
  }

  /** Spends points only if the balance covers them, in one statement, so two taps cannot spend the same points twice. */
  async spend(row: LedgerRow): Promise<boolean> {
    return (
      (await run(
        this.db
          .prepare(
            `INSERT INTO points_ledger (id, user_id, amount, reason, ref, created_at)
             SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COALESCE(SUM(amount), 0) FROM points_ledger WHERE user_id = ?) >= ?`,
          )
          .bind(
            row.id,
            row.user_id,
            row.amount,
            row.reason,
            row.ref,
            row.created_at,
            row.user_id,
            -row.amount,
          ),
      )) === 1
    );
  }

  find(userId: string, reason: LedgerReason, ref: string): Promise<LedgerRow | null> {
    return first<LedgerRow>(
      this.db
        .prepare('SELECT * FROM points_ledger WHERE user_id = ? AND reason = ? AND ref = ?')
        .bind(userId, reason, ref),
    );
  }

  async countSince(userId: string, reason: LedgerReason, since: number): Promise<number> {
    const row = await first<{ n: number }>(
      this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM points_ledger WHERE user_id = ? AND reason = ? AND created_at >= ?',
        )
        .bind(userId, reason, since),
    );
    return row?.n ?? 0;
  }

  history(userId: string, limit: number): Promise<LedgerRow[]> {
    return all<LedgerRow>(
      this.db
        .prepare('SELECT * FROM points_ledger WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
        .bind(userId, limit),
    );
  }

  // ---- codes

  inviteCodeOf(userId: string): Promise<{ code: string } | null> {
    return first<{ code: string }>(
      this.db.prepare('SELECT code FROM invite_codes WHERE user_id = ?').bind(userId),
    );
  }

  /** True when the code was free and is now this person's. */
  async claimInviteCode(userId: string, code: string, now: number): Promise<boolean> {
    if (await this.partnerByCode(code)) return false;
    return (
      (await run(
        this.db
          .prepare('INSERT OR IGNORE INTO invite_codes (user_id, code, created_at) VALUES (?, ?, ?)')
          .bind(userId, code, now),
      )) === 1
    );
  }

  ownerOfInviteCode(code: string): Promise<{ user_id: string } | null> {
    return first<{ user_id: string }>(
      this.db.prepare('SELECT user_id FROM invite_codes WHERE code = ?').bind(code),
    );
  }

  // ---- referrals

  referralOf(inviteeId: string): Promise<ReferralRow | null> {
    return first<ReferralRow>(
      this.db.prepare('SELECT * FROM referrals WHERE invitee_id = ?').bind(inviteeId),
    );
  }

  async addReferral(inviteeId: string, inviterId: string, now: number): Promise<boolean> {
    return (
      (await run(
        this.db
          .prepare('INSERT OR IGNORE INTO referrals (invitee_id, inviter_id, created_at) VALUES (?, ?, ?)')
          .bind(inviteeId, inviterId, now),
      )) === 1
    );
  }

  async markReferralRewarded(inviteeId: string, now: number): Promise<boolean> {
    return (
      (await run(
        this.db
          .prepare('UPDATE referrals SET rewarded_at = ? WHERE invitee_id = ? AND rewarded_at IS NULL')
          .bind(now, inviteeId),
      )) === 1
    );
  }

  async referralCounts(inviterId: string): Promise<{ joined: number; rewarded: number }> {
    const row = await first<{ joined: number; rewarded: number }>(
      this.db
        .prepare(
          'SELECT COUNT(*) AS joined, COUNT(rewarded_at) AS rewarded FROM referrals WHERE inviter_id = ?',
        )
        .bind(inviterId),
    );
    return { joined: row?.joined ?? 0, rewarded: row?.rewarded ?? 0 };
  }

  async loggedDays(userId: string): Promise<number> {
    const row = await first<{ n: number }>(
      this.db
        .prepare(
          'SELECT COUNT(DISTINCT local_date) AS n FROM diary_entries WHERE user_id = ? AND deleted_at IS NULL',
        )
        .bind(userId),
    );
    return row?.n ?? 0;
  }

  accountCreatedAt(userId: string): Promise<{ created_at: number } | null> {
    return first<{ created_at: number }>(
      this.db.prepare('SELECT created_at FROM users WHERE id = ?').bind(userId),
    );
  }

  // ---- partners

  partnerByCode(code: string): Promise<PartnerRow | null> {
    return first<PartnerRow>(this.db.prepare('SELECT * FROM partners WHERE code = ?').bind(code));
  }

  partner(id: string): Promise<PartnerRow | null> {
    return first<PartnerRow>(this.db.prepare('SELECT * FROM partners WHERE id = ?').bind(id));
  }

  async addPartner(p: PartnerRow): Promise<void> {
    await run(
      this.db
        .prepare(
          'INSERT INTO partners (id, name, code, share_pct, months, welcome_points, contact, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          p.id,
          p.name,
          p.code,
          p.share_pct,
          p.months,
          p.welcome_points,
          p.contact,
          p.active,
          p.created_at,
        ),
    );
  }

  async updatePartner(
    id: string,
    patch: Partial<
      Pick<PartnerRow, 'name' | 'share_pct' | 'months' | 'welcome_points' | 'contact' | 'active'>
    >,
  ): Promise<void> {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    await run(
      this.db
        .prepare(`UPDATE partners SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .bind(...keys.map((k) => patch[k] ?? null), id),
    );
  }

  /** Every partner with its members, members on Plus, and earnings (owed: earned, not reversed, not yet paid). */
  listPartners(
    now: number,
  ): Promise<
    (PartnerRow & { members: number; plus_members: number; earned_cents: number; owed_cents: number })[]
  > {
    return all(
      this.db
        .prepare(
          `SELECT p.*,
             (SELECT COUNT(*) FROM partner_signups s WHERE s.partner_id = p.id) AS members,
             (SELECT COUNT(DISTINCT s.user_id) FROM partner_signups s JOIN subscriptions b ON b.user_id = s.user_id
                WHERE s.partner_id = p.id AND b.status IN ('active', 'in_grace', 'canceled') AND b.current_period_end > ?) AS plus_members,
             (SELECT COALESCE(SUM(earning_cents), 0) FROM partner_earnings e WHERE e.partner_id = p.id AND e.reversed_at IS NULL) AS earned_cents,
             (SELECT COALESCE(SUM(earning_cents), 0) FROM partner_earnings e WHERE e.partner_id = p.id AND e.reversed_at IS NULL AND e.paid_at IS NULL) AS owed_cents
           FROM partners p ORDER BY p.created_at`,
        )
        .bind(now),
    );
  }

  signupOf(userId: string): Promise<(PartnerRow & { joined_at: number }) | null> {
    return first(
      this.db
        .prepare(
          'SELECT p.*, s.created_at AS joined_at FROM partner_signups s JOIN partners p ON p.id = s.partner_id WHERE s.user_id = ?',
        )
        .bind(userId),
    );
  }

  async addSignup(userId: string, partnerId: string, now: number): Promise<boolean> {
    return (
      (await run(
        this.db
          .prepare('INSERT OR IGNORE INTO partner_signups (user_id, partner_id, created_at) VALUES (?, ?, ?)')
          .bind(userId, partnerId, now),
      )) === 1
    );
  }

  async addEarning(e: EarningRow): Promise<boolean> {
    return (
      (await run(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO partner_earnings (id, partner_id, user_id, subscription_id, period_end, product_id, gross_cents, earning_cents, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            e.id,
            e.partner_id,
            e.user_id,
            e.subscription_id,
            e.period_end,
            e.product_id,
            e.gross_cents,
            e.earning_cents,
            e.created_at,
          ),
      )) === 1
    );
  }

  /** A refund takes back the share of the subscription's latest period (once: hearing of it again changes nothing). */
  reverseLatestEarning(subscriptionId: string, now: number): Promise<number> {
    return run(
      this.db
        .prepare(
          `UPDATE partner_earnings SET reversed_at = ? WHERE id = (
             SELECT id FROM partner_earnings WHERE subscription_id = ? ORDER BY period_end DESC LIMIT 1) AND reversed_at IS NULL`,
        )
        .bind(now, subscriptionId),
    );
  }

  earnings(partnerId: string, from: number, to: number): Promise<EarningRow[]> {
    return all<EarningRow>(
      this.db
        .prepare(
          'SELECT * FROM partner_earnings WHERE partner_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at',
        )
        .bind(partnerId, from, to),
    );
  }

  async signupsBetween(partnerId: string, from: number, to: number): Promise<number> {
    const row = await first<{ n: number }>(
      this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM partner_signups WHERE partner_id = ? AND created_at >= ? AND created_at < ?',
        )
        .bind(partnerId, from, to),
    );
    return row?.n ?? 0;
  }

  /** Marks everything owed up to `until` as paid. Returns how many rows and how much. */
  async markPaid(partnerId: string, until: number, now: number): Promise<{ rows: number; cents: number }> {
    const owed = await first<{ n: number; cents: number | null }>(
      this.db
        .prepare(
          'SELECT COUNT(*) AS n, SUM(earning_cents) AS cents FROM partner_earnings WHERE partner_id = ? AND reversed_at IS NULL AND paid_at IS NULL AND created_at < ?',
        )
        .bind(partnerId, until),
    );
    await run(
      this.db
        .prepare(
          'UPDATE partner_earnings SET paid_at = ? WHERE partner_id = ? AND reversed_at IS NULL AND paid_at IS NULL AND created_at < ?',
        )
        .bind(now, partnerId, until),
    );
    return { rows: owed?.n ?? 0, cents: owed?.cents ?? 0 };
  }

  // ---- Plus months bought with points

  grants(userId: string): Promise<GrantRow[]> {
    return all<GrantRow>(
      this.db.prepare('SELECT * FROM reward_grants WHERE user_id = ? ORDER BY ends_at').bind(userId),
    );
  }

  async addGrant(g: GrantRow): Promise<void> {
    await run(
      this.db
        .prepare(
          'INSERT INTO reward_grants (id, user_id, starts_at, ends_at, points, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(g.id, g.user_id, g.starts_at, g.ends_at, g.points, g.created_at),
    );
  }
}
