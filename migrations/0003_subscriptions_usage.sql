-- Subscriptions (one row per purchase token) with an idempotent event ledger, and per-day usage counters.

CREATE TABLE subscriptions (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider           TEXT NOT NULL CHECK (provider IN ('mock', 'google_play')),
  product_id         TEXT NOT NULL,
  external_id        TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('active', 'trialing', 'in_grace', 'on_hold', 'paused', 'canceled', 'expired', 'refunded')),
  auto_renew         INTEGER NOT NULL DEFAULT 1,
  started_at         INTEGER NOT NULL,
  current_period_end INTEGER NOT NULL,
  grace_until        INTEGER,
  canceled_at        INTEGER,
  environment        TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (provider, external_id)
);
CREATE INDEX subscriptions_user ON subscriptions (user_id, updated_at);

-- One row per notification from the store. event_key is the store's message id, so a redelivery changes nothing.
CREATE TABLE subscription_events (
  id              TEXT PRIMARY KEY,
  subscription_id TEXT REFERENCES subscriptions (id) ON DELETE CASCADE,
  event_key       TEXT NOT NULL UNIQUE,
  type            TEXT NOT NULL,
  payload         TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX subscription_events_sub ON subscription_events (subscription_id);

-- Counts per user, per key, per local day. Incremented atomically in one statement so a limit cannot be raced past.
CREATE TABLE usage_counters (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  period  TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, key, period)
);
