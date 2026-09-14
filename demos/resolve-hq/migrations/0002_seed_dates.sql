-- Seed timestamps in 0001 were off by a year on the first remote apply. Skip rows that are already in 2026.
UPDATE tickets
SET created_at = created_at + 31536000000,
    updated_at = updated_at + 31536000000
WHERE created_at < 1767225600000;

UPDATE messages
SET created_at = created_at + 31536000000
WHERE created_at < 1767225600000;

UPDATE attachments
SET created_at = created_at + 31536000000
WHERE created_at < 1767225600000;
