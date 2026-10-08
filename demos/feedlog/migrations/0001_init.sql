CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'planned', 'in_progress', 'done', 'closed')),
  votes INTEGER NOT NULL DEFAULT 0 CHECK (votes >= 0),
  display_name TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  image_key TEXT,
  image_type TEXT,
  seeded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX posts_status_votes ON posts (status, votes DESC);
CREATE INDEX posts_created ON posts (created_at DESC);
CREATE INDEX posts_expires ON posts (expires_at);

CREATE TABLE votes (
  post_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, visitor_id)
);

CREATE TABLE changelog (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  seeded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX changelog_published ON changelog (published_at DESC);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Seeded rows do not expire. The expired fixture is a visitor row the cron should delete.
INSERT INTO posts (id, title, body, status, votes, display_name, visitor_id, seeded, created_at, expires_at) VALUES
  (
    'post_dark_roadmap',
    'Dark mode on the public roadmap',
    'The board is readable at night, but the roadmap columns stay bright. A dark theme for the public pages would match the rest of the product.',
    'planned',
    24,
    'Mina Okonkwo',
    'seed',
    1,
    1788307200000,
    NULL
  ),
  (
    'post_vote_mail',
    'Email me when a post I voted on ships',
    'I upvote and then lose the thread. A short note when the status moves to done would close the loop.',
    'open',
    17,
    'Northwind',
    'seed',
    1,
    1788912000000,
    NULL
  ),
  (
    'post_upvote_key',
    'Press U to upvote the post under the cursor',
    'Voting from the keyboard would make triage faster on a laptop. One shortcut, one post, no extra chrome.',
    'in_progress',
    11,
    'Harbor team',
    'seed',
    1,
    1789516800000,
    NULL
  ),
  (
    'post_csv_export',
    'Export the board to CSV',
    'Finance wants a spreadsheet of titles, votes, and status. A single download is enough. No API keys.',
    'done',
    9,
    'Northwind',
    'seed',
    1,
    1790121600000,
    NULL
  ),
  (
    'post_admin_sso',
    'SSO for the admin console',
    'Company login for status changes is more than this public demo should take on. Closing it in favor of a single admin token.',
    'closed',
    4,
    'Harbor team',
    'seed',
    1,
    1790553600000,
    NULL
  ),
  (
    'post_expired_fixture',
    'Expired fixture: retire the import wizard',
    'This visitor post is already past its TTL so the hourly cleanup can delete it.',
    'open',
    1,
    'Visitor',
    'expired',
    0,
    1788307200000,
    1
  );

INSERT INTO changelog (id, title, body, published_at, seeded) VALUES
  (
    'log_roadmap',
    'Public roadmap',
    'Planned, in progress, and done now have their own columns. Open and closed stay on the board.',
    1790812800000,
    1
  ),
  (
    'log_similar',
    'Duplicate spotting',
    'While you type a new post, the board looks for a similar one so the same request does not land twice.',
    1791244800000,
    1
  );

INSERT INTO meta (key, value) VALUES ('seed', '1');
