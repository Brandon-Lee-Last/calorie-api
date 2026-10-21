-- Rate limits that every Worker instance shares. The key already has the client's address hashed in, so no raw IP is stored.
CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
CREATE INDEX rate_limits_window ON rate_limits (window_start);
