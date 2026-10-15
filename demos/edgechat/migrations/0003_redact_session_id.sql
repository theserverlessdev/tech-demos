-- Pre-fix rows stored the cookie value in messages.session_id. New writes already use 'redacted'.
UPDATE messages SET session_id = 'redacted' WHERE session_id NOT IN ('redacted', 'seed');
