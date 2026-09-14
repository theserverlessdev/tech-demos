CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'pending', 'resolved')),
  priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assignee TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX tickets_updated_at ON tickets (updated_at DESC);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('customer', 'agent')),
  author_name TEXT NOT NULL,
  author_email TEXT,
  body TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('seed', 'queue', 'agent', 'web')),
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_ticket_created ON messages (ticket_id, created_at);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX attachments_ticket ON attachments (ticket_id);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Lived-in sample inbox. Epoch ms around 2026-09-10 … 2026-09-14.
INSERT INTO tickets (id, number, subject, customer_name, customer_email, status, priority, assignee, created_at, updated_at) VALUES
  ('tkt_billing', 1042, 'Invoice double-charged for March', 'Priya Raman', 'priya@northwind.example', 'open', 'high', 'Maya Chen', 1788998400000, 1789027200000),
  ('tkt_sso', 1043, 'SSO login loop on Safari 26', 'Eli Vargas', 'eli@atlas-labs.example', 'pending', 'urgent', 'Jordan Park', 1789084800000, 1789106400000),
  ('tkt_cron', 1044, 'Scheduled jobs skipped after timezone change', 'Sam Okonkwo', 'sam@nimbus-jobs.example', 'open', 'normal', NULL, 1789171200000, 1789178400000),
  ('tkt_webhooks', 1045, 'Webhook deliveries delayed overnight', 'Chen Wei', 'wei@harborpay.example', 'open', 'high', 'Maya Chen', 1789257600000, 1789286400000),
  ('tkt_docs', 1046, 'API token rotation docs are stale', 'Riley Cho', 'riley@lumen-cms.example', 'resolved', 'low', 'Jordan Park', 1788825600000, 1788912000000);

INSERT INTO messages (id, ticket_id, author_kind, author_name, author_email, body, via, created_at) VALUES
  ('msg_billing_1', 'tkt_billing', 'customer', 'Priya Raman', 'priya@northwind.example', 'We were billed twice for March on invoice INV-8841. The first charge posted on the 1st, then a second identical charge on the 3rd. Can you reverse the duplicate and confirm the next invoice will be a single line?', 'seed', 1788998400000),
  ('msg_billing_2', 'tkt_billing', 'agent', 'Maya Chen', NULL, 'Thanks Priya — I can see both charges. I am pulling the ledger for INV-8841 and will follow up once finance confirms the reversal window.', 'seed', 1789027200000),
  ('msg_sso_1', 'tkt_sso', 'customer', 'Eli Vargas', 'eli@atlas-labs.example', 'Safari 26 on macOS keeps bouncing between /login and /callback after we turned on Google SSO. Chrome on the same machine works. We have cookies enabled. HAR attached in the next note if you want it.', 'seed', 1789084800000),
  ('msg_sso_2', 'tkt_sso', 'agent', 'Jordan Park', NULL, 'This looks like SameSite on the session cookie plus Safari ITP. I have a staging flag to set SameSite=None; Secure. Holding the ticket pending your test on that flag.', 'seed', 1789106400000),
  ('msg_cron_1', 'tkt_cron', 'customer', 'Sam Okonkwo', 'sam@nimbus-jobs.example', 'After we moved the workspace from UTC to America/Chicago, three nightly jobs never fired. The dashboard still shows them as scheduled. No error in the last 24h of logs.', 'seed', 1789171200000),
  ('msg_cron_2', 'tkt_cron', 'customer', 'Sam Okonkwo', 'sam@nimbus-jobs.example', 'Update: the 02:00 job ran once this morning, but the 02:30 and 03:00 jobs are still skipped.', 'seed', 1789178400000),
  ('msg_webhooks_1', 'tkt_webhooks', 'customer', 'Chen Wei', 'wei@harborpay.example', 'Payout webhooks from 01:12–04:40 UTC landed 20–40 minutes late. Signatures still verified. This is the second night in a row. We can share delivery IDs.', 'seed', 1789257600000),
  ('msg_webhooks_2', 'tkt_webhooks', 'agent', 'Maya Chen', NULL, 'Acknowledged. I am checking the outbound queue depth for that window. Please send two example delivery IDs so we can match them to worker logs.', 'seed', 1789286400000),
  ('msg_docs_1', 'tkt_docs', 'customer', 'Riley Cho', 'riley@lumen-cms.example', 'The token rotation guide still says to hit POST /v1/tokens/rotate. That 404s. Is it PATCH /v2/keys now?', 'seed', 1788825600000),
  ('msg_docs_2', 'tkt_docs', 'agent', 'Jordan Park', NULL, 'Yes — rotate with PATCH /v2/keys/{id}/rotate. I updated the public docs and closed this out. Thanks for the catch.', 'seed', 1788912000000);

INSERT INTO attachments (id, ticket_id, r2_key, filename, content_type, size, created_at) VALUES
  ('att_billing_seed', 'tkt_billing', 'seed/inv-8841-duplicate.txt', 'inv-8841-duplicate.txt', 'text/plain; charset=utf-8', 0, 1788998500000);

INSERT INTO meta (key, value) VALUES ('seeded_r2', '0');
