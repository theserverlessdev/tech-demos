CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL
);
CREATE INDEX rooms_last_message ON rooms (last_message_at DESC);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  session_id TEXT NOT NULL,
  body TEXT NOT NULL,
  attachment_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_room_created ON messages (room_id, created_at);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX attachments_room ON attachments (room_id);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Lived-in lobby so the first visit is not an empty pane. Epoch ms around 2026-09-15.
INSERT INTO rooms (id, name, created_at, last_message_at) VALUES
  ('lobby', 'lobby', 1789459200000, 1789462800000);

INSERT INTO messages (id, room_id, author, session_id, body, attachment_id, created_at) VALUES
  ('msg_lobby_1', 'lobby', 'EdgeChat', 'seed', 'Lobby is the shared demo room. Open a second tab, pick a name, and send something — the other tab should see it live.', NULL, 1789459200000),
  ('msg_lobby_2', 'lobby', 'EdgeChat', 'seed', 'History lives in D1, so a refresh keeps the thread. Display names sit in KV. Attach a file to put bytes in R2; the Durable Object only fans the message out.', 'att_lobby_seed', 1789462800000);

INSERT INTO attachments (id, room_id, r2_key, filename, content_type, size, created_at) VALUES
  ('att_lobby_seed', 'lobby', 'seed/welcome.txt', 'welcome.txt', 'text/plain; charset=utf-8', 0, 1789462800000);

INSERT INTO meta (key, value) VALUES ('seeded_r2', '0');
