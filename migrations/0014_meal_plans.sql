-- Meal plans: diet styles and the meals they are built from. Both are content, loaded through the admin API
-- (scripts/import-content.mjs). Each row keeps its validated content as JSON; only what queries need is a column.

CREATE TABLE diets (
  slug       TEXT PRIMARY KEY,
  tier       TEXT NOT NULL CHECK (tier IN ('free', 'pro')),
  position   INTEGER NOT NULL DEFAULT 0,
  body       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A meal is free to see in full when it belongs to at least one free diet (worked out when read, so moving a diet
-- between free and Pro needs no meal changes).
CREATE TABLE meals (
  slug       TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
