-- Push reminders: the phones to notify and when each reminder is next due.

CREATE TABLE devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token        TEXT NOT NULL UNIQUE,
  platform     TEXT NOT NULL CHECK (platform IN ('android')),
  app_version  TEXT,
  locale       TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX devices_user ON devices (user_id);
CREATE INDEX devices_seen ON devices (last_seen_at);

-- One row per reminder kind per person. next_due_at is the next moment it should fire, worked out in the person's timezone,
-- so finding what is due is one indexed range read however many people there are.
CREATE TABLE reminders (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('breakfast', 'lunch', 'dinner', 'water', 'weigh_in', 'log_nudge')),
  local_time   TEXT NOT NULL,
  days_mask    INTEGER NOT NULL DEFAULT 127,
  enabled      INTEGER NOT NULL DEFAULT 1,
  next_due_at  INTEGER,
  last_sent_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (user_id, kind)
);
CREATE INDEX reminders_due ON reminders (next_due_at) WHERE enabled = 1 AND next_due_at IS NOT NULL;
