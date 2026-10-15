-- Visitor lookup on every board load was a full scan of the covering PK.
CREATE INDEX votes_visitor ON votes (visitor_id);

-- Images stay off the public board until an admin approves them.
ALTER TABLE posts ADD COLUMN image_approved INTEGER NOT NULL DEFAULT 0;

-- Session-bound gate: remaining uses live in D1 so a replayed cookie cannot reset the counters.
CREATE TABLE used_gates (
  nonce TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  remaining_similar INTEGER NOT NULL,
  remaining_create INTEGER NOT NULL,
  exp INTEGER NOT NULL
);
CREATE INDEX used_gates_exp ON used_gates (exp);

-- Retry R2 / Vectorize deletes that failed after the D1 row was removed.
CREATE TABLE pending_deletes (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, key)
);
