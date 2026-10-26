-- Ask Pango, the coach: the conversation, kept for 90 days (maintenance removes older messages) so it carries on across
-- phones. The server keeps it so the model only ever sees history the server wrote; a phone cannot forge Pango's replies.
CREATE TABLE coach_messages (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  -- For Pango's replies: chat (the model's answer, checked), crisis (helplines), scope (an attack or off-limits request
  -- turned away), blocked (the model's answer failed a check and was replaced).
  kind       TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'crisis', 'scope', 'blocked')),
  flags      TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX coach_messages_user ON coach_messages (user_id, created_at);
