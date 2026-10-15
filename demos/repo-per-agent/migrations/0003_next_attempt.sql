-- Retry time is separate from expiry so a failed delete cannot bring a
-- task back as live. agent_started lets cron skip purge() when no DO ran.
ALTER TABLE tasks ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN agent_started INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS tasks_cleanup ON tasks (expires_at, next_attempt_at);
