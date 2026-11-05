-- Pango Points, invites, partner (gym) codes and their earnings, and Plus months bought with points.

-- Every change to a balance is a row; the balance is the sum. (reason, ref) is unique per user, so an award for the
-- same thing (a food, a referral) can never be given twice, however often the hook runs.
CREATE TABLE points_ledger (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  amount     INTEGER NOT NULL,
  reason     TEXT NOT NULL CHECK (reason IN ('food', 'food_removed', 'invited_friend', 'joined_with_invite', 'partner_welcome', 'redeemed', 'adjustment')),
  ref        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, reason, ref)
);
CREATE INDEX points_ledger_user ON points_ledger (user_id, created_at);

-- Each person's own invite code, made the first time they look.
CREATE TABLE invite_codes (
  user_id    TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  code       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- Who invited whom. Rewarded once the invited person has logged food on a few different days.
CREATE TABLE referrals (
  invitee_id  TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  inviter_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  rewarded_at INTEGER
);
CREATE INDEX referrals_inviter ON referrals (inviter_id, rewarded_at);

-- Partners (gyms) with their own code: a share of what their members pay for Plus, for a number of months.
CREATE TABLE partners (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  code           TEXT NOT NULL UNIQUE,
  share_pct      REAL NOT NULL CHECK (share_pct >= 0 AND share_pct <= 100),
  months         INTEGER NOT NULL CHECK (months >= 0),
  welcome_points INTEGER NOT NULL DEFAULT 0,
  contact        TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL
);

-- Which partner a person joined through (one each).
CREATE TABLE partner_signups (
  user_id    TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  partner_id TEXT NOT NULL REFERENCES partners (id),
  created_at INTEGER NOT NULL
);
CREATE INDEX partner_signups_partner ON partner_signups (partner_id, created_at);

-- One row per paid Plus period of a partner's member: what the partner earned from it. Kept when the member deletes
-- their account (user_id is cleared), since the partner was still owed it.
CREATE TABLE partner_earnings (
  id              TEXT PRIMARY KEY,
  partner_id      TEXT NOT NULL REFERENCES partners (id),
  user_id         TEXT REFERENCES users (id) ON DELETE SET NULL,
  subscription_id TEXT NOT NULL,
  period_end      INTEGER NOT NULL,
  product_id      TEXT NOT NULL,
  gross_cents     INTEGER NOT NULL,
  earning_cents   INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  reversed_at     INTEGER,
  paid_at         INTEGER,
  UNIQUE (subscription_id, period_end)
);
CREATE INDEX partner_earnings_partner ON partner_earnings (partner_id, created_at);

-- Plus months bought with points: Plus from starts_at to ends_at, alongside any store subscription.
CREATE TABLE reward_grants (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  starts_at  INTEGER NOT NULL,
  ends_at    INTEGER NOT NULL,
  points     INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX reward_grants_user ON reward_grants (user_id, ends_at);
