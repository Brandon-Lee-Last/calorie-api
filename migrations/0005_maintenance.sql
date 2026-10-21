-- Old tombstones are removed by the nightly job. `purged_rev` remembers the highest revision that was ever removed for a
-- user, so a device that last synced before that point is told to start over instead of silently missing deletions.
ALTER TABLE users ADD COLUMN purged_rev INTEGER NOT NULL DEFAULT 0;

-- Tombstones are rare, so these partial indexes are tiny, and they keep the nightly purge from scanning whole tables.
CREATE INDEX diary_tombstones ON diary_entries (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX weight_tombstones ON weight_logs (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX water_tombstones ON water_logs (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX foods_tombstones ON foods (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX sessions_tombstones ON workout_sessions (deleted_at) WHERE deleted_at IS NOT NULL;
