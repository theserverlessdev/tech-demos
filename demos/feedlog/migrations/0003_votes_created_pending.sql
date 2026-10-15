-- Bound the hourly seed-vote sweep (post_id + created_at) instead of a PK scan per seed.
CREATE INDEX votes_post_created ON votes (post_id, created_at);

-- Failed R2 / Vectorize deletes: skip keys that keep throwing so they cannot block the queue.
ALTER TABLE pending_deletes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
