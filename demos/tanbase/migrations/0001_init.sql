CREATE TABLE visitors (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_boards_visitor ON boards (visitor_id);
CREATE INDEX idx_boards_expires ON boards (expires_at);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  column_name TEXT NOT NULL CHECK (column_name IN ('todo', 'doing', 'done')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_at INTEGER,
  position INTEGER NOT NULL,
  parent_id TEXT,
  split_id TEXT,
  overdue INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_tasks_board ON tasks (board_id, column_name, position);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_attachments_board ON attachments (board_id);
CREATE INDEX idx_attachments_task ON attachments (task_id);

CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  task_id TEXT NOT NULL UNIQUE,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE splits (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  instance_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  steps_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_splits_board ON splits (board_id, created_at);
