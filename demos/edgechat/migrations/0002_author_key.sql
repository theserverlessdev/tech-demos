-- Public author key (not the session cookie) and denormalized room list fields.
ALTER TABLE rooms ADD COLUMN last_preview TEXT NOT NULL DEFAULT '';
ALTER TABLE rooms ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN author_key TEXT;

UPDATE messages SET author_key = 'legacy-' || id WHERE author_key IS NULL;
UPDATE messages SET author_key = 'seed-public' WHERE session_id = 'seed';

UPDATE rooms SET
  message_count = (SELECT COUNT(*) FROM messages WHERE messages.room_id = rooms.id),
  last_preview = COALESCE((SELECT body FROM messages WHERE messages.room_id = rooms.id ORDER BY created_at DESC LIMIT 1), ''),
  last_message_at = COALESCE((SELECT created_at FROM messages WHERE messages.room_id = rooms.id ORDER BY created_at DESC LIMIT 1), last_message_at);
