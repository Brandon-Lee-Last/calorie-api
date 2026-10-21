-- Recipes, exercise and steps, body measurements and progress photos. Every table syncs like the diary: per-user revision,
-- last-edit-wins on client_updated_at, deletions kept as tombstones until the nightly purge.

CREATE TABLE recipes (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  servings         REAL NOT NULL,
  ingredients      TEXT NOT NULL,
  instructions     TEXT,
  prep_minutes     INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  client_updated_at INTEGER NOT NULL,
  rev              INTEGER NOT NULL
);
CREATE INDEX recipes_user_name ON recipes (user_id, name) WHERE deleted_at IS NULL;
CREATE INDEX recipes_user_rev ON recipes (user_id, rev);
CREATE INDEX recipes_tombstones ON recipes (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE activity_logs (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  logged_at        INTEGER NOT NULL,
  local_date       TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('walking', 'running', 'cycling', 'swimming', 'strength', 'yoga', 'hiit', 'sport', 'steps', 'other')),
  name             TEXT,
  duration_min     REAL,
  steps            INTEGER,
  distance_km      REAL,
  calories_burned  REAL,
  calories_estimated INTEGER NOT NULL DEFAULT 0,
  note             TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  client_updated_at INTEGER NOT NULL,
  rev              INTEGER NOT NULL
);
CREATE INDEX activity_user_date ON activity_logs (user_id, local_date) WHERE deleted_at IS NULL;
CREATE INDEX activity_user_rev ON activity_logs (user_id, rev);
CREATE INDEX activity_tombstones ON activity_logs (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE body_measurements (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  logged_at        INTEGER NOT NULL,
  local_date       TEXT NOT NULL,
  type             TEXT NOT NULL CHECK (type IN ('neck', 'shoulders', 'chest', 'waist', 'hips', 'thigh', 'arm', 'calf', 'body_fat')),
  value            REAL NOT NULL,
  note             TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  client_updated_at INTEGER NOT NULL,
  rev              INTEGER NOT NULL
);
CREATE INDEX measurements_user_date ON body_measurements (user_id, local_date) WHERE deleted_at IS NULL;
CREATE INDEX measurements_user_rev ON body_measurements (user_id, rev);
CREATE INDEX measurements_tombstones ON body_measurements (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE progress_photos (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  logged_at        INTEGER NOT NULL,
  local_date       TEXT NOT NULL,
  pose             TEXT NOT NULL CHECK (pose IN ('front', 'side', 'back', 'other')),
  weight_kg        REAL,
  note             TEXT,
  photo_key        TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  client_updated_at INTEGER NOT NULL,
  rev              INTEGER NOT NULL
);
CREATE INDEX progress_user_date ON progress_photos (user_id, local_date) WHERE deleted_at IS NULL;
CREATE INDEX progress_user_rev ON progress_photos (user_id, rev);
CREATE INDEX progress_tombstones ON progress_photos (deleted_at) WHERE deleted_at IS NOT NULL;
