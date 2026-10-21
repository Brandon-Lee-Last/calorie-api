-- Workout library (exercises, programs, workouts), media files, and a person's progress through them.
-- Content is written by the admin API; people only read it, enrol in programs and log their own sessions.

-- A file or link. `provider` says where the bytes live: our R2 bucket, Cloudflare Stream, or somebody else's URL.
CREATE TABLE media (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL CHECK (kind IN ('video', 'image', 'pdf')),
  provider    TEXT NOT NULL CHECK (provider IN ('r2', 'stream', 'external')),
  location    TEXT,
  mime        TEXT,
  bytes       INTEGER,
  duration_s  INTEGER,
  width       INTEGER,
  height      INTEGER,
  title       TEXT,
  tier        TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE exercises (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  name_norm       TEXT NOT NULL,
  muscle_groups   TEXT NOT NULL DEFAULT '[]',
  equipment       TEXT NOT NULL DEFAULT '[]',
  difficulty      TEXT NOT NULL CHECK (difficulty IN ('beginner', 'intermediate', 'advanced')),
  instructions    TEXT NOT NULL DEFAULT '',
  tips            TEXT,
  image_media_id  TEXT REFERENCES media (id) ON DELETE SET NULL,
  video_media_id  TEXT REFERENCES media (id) ON DELETE SET NULL,
  source          TEXT,
  licence         TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX exercises_name ON exercises (name_norm);

CREATE TABLE programs (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  summary         TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  level           TEXT NOT NULL CHECK (level IN ('beginner', 'intermediate', 'advanced')),
  goal            TEXT NOT NULL CHECK (goal IN ('strength', 'muscle', 'fat_loss', 'endurance', 'mobility', 'general')),
  weeks           INTEGER NOT NULL,
  days_per_week   INTEGER NOT NULL,
  equipment       TEXT NOT NULL DEFAULT '[]',
  cover_media_id  TEXT REFERENCES media (id) ON DELETE SET NULL,
  tier            TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro')),
  author          TEXT,
  position        INTEGER NOT NULL DEFAULT 0,
  published_at    INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX programs_published ON programs (published_at, position);

-- `key` is the stable name of a workout inside its program (for example "w1d1"), so re-importing a program keeps
-- the ids that people's history points at. `tier_override` lets a Pro program offer free sample workouts.
CREATE TABLE workouts (
  id             TEXT PRIMARY KEY,
  program_id     TEXT NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  key            TEXT NOT NULL,
  week           INTEGER NOT NULL,
  day            INTEGER NOT NULL,
  position       INTEGER NOT NULL DEFAULT 0,
  title          TEXT NOT NULL,
  notes          TEXT,
  est_minutes    INTEGER,
  tier_override  TEXT CHECK (tier_override IN ('free', 'pro')),
  UNIQUE (program_id, key)
);
CREATE INDEX workouts_program ON workouts (program_id, week, day, position);

CREATE TABLE workout_exercises (
  id           TEXT PRIMARY KEY,
  workout_id   TEXT NOT NULL REFERENCES workouts (id) ON DELETE CASCADE,
  exercise_id  TEXT NOT NULL REFERENCES exercises (id) ON DELETE RESTRICT,
  position     INTEGER NOT NULL,
  sets         INTEGER NOT NULL,
  reps_min     INTEGER,
  reps_max     INTEGER,
  duration_s   INTEGER,
  rest_s       INTEGER,
  notes        TEXT,
  UNIQUE (workout_id, position)
);
CREATE INDEX workout_exercises_exercise ON workout_exercises (exercise_id);

CREATE TABLE program_enrollments (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  program_id  TEXT NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('active', 'completed', 'left')),
  started_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (user_id, program_id)
);
-- A person follows one program at a time.
CREATE UNIQUE INDEX program_enrollments_one_active ON program_enrollments (user_id) WHERE status = 'active';

-- A logged workout: the sets are stored inside the row as JSON so a session syncs as a single record.
-- workout_id / program_id are kept without foreign keys so history survives a program being edited or removed.
CREATE TABLE workout_sessions (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workout_id        TEXT,
  program_id        TEXT,
  title             TEXT NOT NULL,
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER,
  local_date        TEXT NOT NULL,
  sets              TEXT NOT NULL DEFAULT '[]',
  notes             TEXT,
  rating            INTEGER,
  calories_burned   REAL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  client_updated_at INTEGER NOT NULL,
  rev               INTEGER NOT NULL
);
CREATE INDEX sessions_user_date ON workout_sessions (user_id, local_date) WHERE deleted_at IS NULL;
CREATE INDEX sessions_user_rev ON workout_sessions (user_id, rev);
