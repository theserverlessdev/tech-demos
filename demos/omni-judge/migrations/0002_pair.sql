ALTER TABLE judgments ADD COLUMN pair_id TEXT;

CREATE INDEX idx_judgments_pair ON judgments (pair_id);
