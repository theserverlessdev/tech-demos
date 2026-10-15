CREATE TABLE IF NOT EXISTS compares (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  ip_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS compares_day ON compares (day);
CREATE INDEX IF NOT EXISTS compares_day_ip ON compares (day, ip_key);
