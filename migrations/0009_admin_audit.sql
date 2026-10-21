-- Who did what on the admin API. Attempts that were refused are kept too.
CREATE TABLE admin_audit (
  id         TEXT PRIMARY KEY,
  at         INTEGER NOT NULL,
  actor      TEXT NOT NULL,
  method     TEXT NOT NULL,
  path       TEXT NOT NULL,
  status     INTEGER NOT NULL,
  ip_hash    TEXT NOT NULL,
  request_id TEXT NOT NULL
);
CREATE INDEX admin_audit_at ON admin_audit (at DESC, id DESC);
