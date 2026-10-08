-- Cloudflare Email Routing rule id for this inbox. Null when the rule was not created.
ALTER TABLE inboxes ADD COLUMN routing_rule_id TEXT;
