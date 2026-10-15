ALTER TABLE messages ADD COLUMN visitor_id TEXT;
CREATE INDEX messages_ticket_visitor ON messages (ticket_id, visitor_id, created_at);
