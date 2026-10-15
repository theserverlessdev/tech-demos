ALTER TABLE captures ADD COLUMN ip48_key TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS captures_ip48_created ON captures (ip48_key, created_at);
