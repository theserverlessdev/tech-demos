ALTER TABLE captures ADD COLUMN ip_key TEXT NOT NULL DEFAULT '';
ALTER TABLE captures ADD COLUMN has_desktop INTEGER NOT NULL DEFAULT 0;
ALTER TABLE captures ADD COLUMN has_phone INTEGER NOT NULL DEFAULT 0;
ALTER TABLE captures ADD COLUMN has_pdf INTEGER NOT NULL DEFAULT 0;
ALTER TABLE captures ADD COLUMN has_markdown INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS captures_ip_created ON captures (ip_key, created_at);
CREATE INDEX IF NOT EXISTS captures_created ON captures (created_at);
