import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { INSERT_MESSAGE_SQL } from "./src/worker/db.ts";
import { CONSUME_CREATE_QUOTA_SQL } from "./src/worker/keys.ts";
import { KEY_CREATE_LIMIT, KEY_WINDOW_MS, MAX_INBOX_BYTES, MAX_MESSAGES_PER_INBOX } from "./src/worker/limits.ts";

function consume(db: Database, now: number, id = "k1"): boolean {
  const result = db.run(CONSUME_CREATE_QUOTA_SQL, [now, KEY_WINDOW_MS, id]);
  return result.changes === 1;
}

test("atomic create quota admits exactly create_limit rows in one window", () => {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE api_keys (
    id TEXT PRIMARY KEY, revoked INTEGER, create_limit INTEGER, window_start INTEGER, window_creates INTEGER
  )`);
  const now = 1_000_000;
  db.run("INSERT INTO api_keys VALUES ('k1', 0, ?, ?, 0)", [KEY_CREATE_LIMIT, now]);
  let ok = 0;
  for (let i = 0; i < KEY_CREATE_LIMIT + 20; i++) if (consume(db, now + i)) ok++;
  expect(ok).toBe(KEY_CREATE_LIMIT);
  const row = db.query("SELECT window_creates AS n FROM api_keys WHERE id = 'k1'").get() as { n: number };
  expect(row.n).toBe(KEY_CREATE_LIMIT);
});

test("a new 24h window resets the create quota", () => {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE api_keys (
    id TEXT PRIMARY KEY, revoked INTEGER, create_limit INTEGER, window_start INTEGER, window_creates INTEGER
  )`);
  const now = 1_000_000;
  db.run("INSERT INTO api_keys VALUES ('k1', 0, ?, ?, ?)", [KEY_CREATE_LIMIT, now, KEY_CREATE_LIMIT]);
  expect(consume(db, now + 1000)).toBe(false);
  expect(consume(db, now + KEY_WINDOW_MS)).toBe(true);
  const row = db.query("SELECT window_creates AS n, window_start AS s FROM api_keys WHERE id = 'k1'").get() as {
    n: number;
    s: number;
  };
  expect(row.n).toBe(1);
  expect(row.s).toBe(now + KEY_WINDOW_MS);
});

function openMailDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE inboxes (
    id TEXT PRIMARY KEY, local_part TEXT, token_hash TEXT, source TEXT, created_at INTEGER, expires_at INTEGER
  )`);
  db.run(`CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    inbox_id TEXT NOT NULL,
    via TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    envelope_from TEXT NOT NULL,
    from_name TEXT,
    from_address TEXT,
    to_header TEXT,
    subject TEXT NOT NULL,
    snippet TEXT NOT NULL,
    text_body TEXT,
    html_body TEXT,
    truncated INTEGER NOT NULL DEFAULT 0,
    raw_size INTEGER NOT NULL,
    message_id TEXT,
    date_header TEXT,
    codes TEXT NOT NULL DEFAULT '[]',
    links TEXT NOT NULL DEFAULT '[]',
    attachments TEXT NOT NULL DEFAULT '[]',
    text_r2_key TEXT,
    html_r2_key TEXT
  )`);
  return db;
}

function insertBinds(id: string, inbox: string, rawSize: number): unknown[] {
  return [
    id,
    inbox,
    "smtp",
    1,
    "from@x",
    null,
    "from@x",
    "to@x",
    "subj",
    "snip",
    null,
    null,
    0,
    rawSize,
    null,
    null,
    "[]",
    "[]",
    "[]",
    null,
    null,
    inbox,
    MAX_MESSAGES_PER_INBOX,
    inbox,
    rawSize,
    MAX_INBOX_BYTES,
  ];
}

test("5 MB inbox budget is enforced by INSERT_MESSAGE_SQL", () => {
  const db = openMailDb();
  const inbox = "box";
  db.run("INSERT INTO inboxes VALUES (?, 'a', 'h', 'web', 0, 1)", [inbox]);
  const first = db.query(INSERT_MESSAGE_SQL).get(...insertBinds("m1", inbox, MAX_INBOX_BYTES - 100));
  expect(first).toBeTruthy();
  const allowed = db.query(INSERT_MESSAGE_SQL).get(...insertBinds("m2", inbox, 50));
  expect(allowed).toBeTruthy();
  const refused = db.query(INSERT_MESSAGE_SQL).get(...insertBinds("m3", inbox, 200));
  expect(refused).toBeNull();
});
