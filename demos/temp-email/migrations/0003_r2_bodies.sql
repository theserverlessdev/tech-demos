-- HTML and text bodies live in R2. D1 keeps metadata plus the object keys.
-- Legacy rows may still have text_body/html_body until they expire.
ALTER TABLE messages ADD COLUMN text_r2_key TEXT;
ALTER TABLE messages ADD COLUMN html_r2_key TEXT;
