-- Foods, diary, body tracking and scan events.
--
-- Everything a user can change on several devices carries `client_updated_at` (the device's clock, used only to
-- pick a winner when two devices edit the same record) and `rev` (a per-user counter the server increments on
-- every write, used by the sync endpoint to say "give me everything after revision N"). Deleting sets
-- `deleted_at` so other devices hear about it; a nightly job removes old tombstones.

ALTER TABLE users ADD COLUMN sync_rev INTEGER NOT NULL DEFAULT 0;

-- user_id NULL = the shared catalogue (cached from Open Food Facts and similar); otherwise a user's own food.
CREATE TABLE foods (
  id               TEXT PRIMARY KEY,
  user_id          TEXT REFERENCES users (id) ON DELETE CASCADE,
  source           TEXT NOT NULL CHECK (source IN ('custom', 'openfoodfacts', 'usda', 'curated')),
  external_id      TEXT,
  barcode          TEXT,
  name             TEXT NOT NULL,
  name_norm        TEXT NOT NULL,
  brand            TEXT,
  serving_g        REAL,
  serving_label    TEXT,
  calories_100g    REAL NOT NULL,
  protein_100g     REAL NOT NULL,
  carb_100g        REAL NOT NULL,
  fat_100g         REAL NOT NULL,
  fiber_100g       REAL,
  sugar_100g       REAL,
  sodium_mg_100g   REAL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  client_updated_at INTEGER NOT NULL DEFAULT 0,
  rev              INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX foods_user_rev ON foods (user_id, rev) WHERE user_id IS NOT NULL;
CREATE INDEX foods_user_name ON foods (user_id, name_norm) WHERE deleted_at IS NULL;
CREATE INDEX foods_catalogue_name ON foods (name_norm) WHERE user_id IS NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX foods_catalogue_barcode ON foods (barcode) WHERE user_id IS NULL AND barcode IS NOT NULL;
CREATE UNIQUE INDEX foods_catalogue_external ON foods (source, external_id) WHERE user_id IS NULL AND external_id IS NOT NULL;
CREATE UNIQUE INDEX foods_user_barcode ON foods (user_id, barcode) WHERE user_id IS NOT NULL AND barcode IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE diary_entries (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  logged_at        INTEGER NOT NULL,
  local_date       TEXT NOT NULL,
  meal_type        TEXT NOT NULL CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
  name             TEXT NOT NULL,
  food_id          TEXT,
  quantity_g       REAL,
  servings         REAL,
  calories         REAL NOT NULL,
  protein_g        REAL NOT NULL DEFAULT 0,
  carb_g           REAL NOT NULL DEFAULT 0,
  fat_g            REAL NOT NULL DEFAULT 0,
  fiber_g          REAL,
  sugar_g          REAL,
  sodium_mg        REAL,
  source           TEXT NOT NULL CHECK (source IN ('scan', 'manual', 'food', 'barcode', 'ai_text', 'quick_add')),
  scan_id          TEXT,
  photo_key        TEXT,
  note             TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  client_updated_at INTEGER NOT NULL,
  rev              INTEGER NOT NULL
);
CREATE INDEX diary_user_date ON diary_entries (user_id, local_date) WHERE deleted_at IS NULL;
CREATE INDEX diary_user_rev ON diary_entries (user_id, rev);

CREATE TABLE weight_logs (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  logged_at        INTEGER NOT NULL,
  local_date       TEXT NOT NULL,
  weight_kg        REAL NOT NULL,
  note             TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  client_updated_at INTEGER NOT NULL,
  rev              INTEGER NOT NULL
);
CREATE INDEX weight_user_date ON weight_logs (user_id, local_date) WHERE deleted_at IS NULL;
CREATE INDEX weight_user_rev ON weight_logs (user_id, rev);

CREATE TABLE water_logs (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  logged_at        INTEGER NOT NULL,
  local_date       TEXT NOT NULL,
  ml               INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  client_updated_at INTEGER NOT NULL,
  rev              INTEGER NOT NULL
);
CREATE INDEX water_user_date ON water_logs (user_id, local_date) WHERE deleted_at IS NULL;
CREATE INDEX water_user_rev ON water_logs (user_id, rev);

-- What the on-device model said about a photo versus what the person kept. This is the signal for improving the
-- model. The photo itself is only stored when the person agreed (contribute_consent) and lives in R2 at image_key.
CREATE TABLE scan_events (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at        INTEGER NOT NULL,
  client_created_at INTEGER NOT NULL,
  model_version     TEXT NOT NULL,
  food_probability  REAL,
  pred_calories     REAL,
  pred_mass_g       REAL,
  pred_fat_g        REAL,
  pred_carb_g       REAL,
  pred_protein_g    REAL,
  outcome           TEXT NOT NULL CHECK (outcome IN ('saved', 'edited', 'discarded', 'not_food')),
  final_calories    REAL,
  final_mass_g      REAL,
  final_fat_g       REAL,
  final_carb_g      REAL,
  final_protein_g   REAL,
  portion           REAL,
  contribute_consent INTEGER NOT NULL DEFAULT 0,
  image_key         TEXT
);
CREATE INDEX scan_user_time ON scan_events (user_id, created_at);
CREATE INDEX scan_model ON scan_events (model_version, created_at);
