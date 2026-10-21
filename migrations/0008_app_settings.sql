-- Switches an admin can flip without a deploy: maintenance mode, minimum app version, feature kill switches.
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
