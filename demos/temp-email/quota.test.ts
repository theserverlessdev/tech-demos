import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { CONSUME_CREATE_QUOTA_SQL } from "./src/worker/keys.ts";
import { KEY_CREATE_LIMIT, KEY_WINDOW_MS, MAX_INBOX_BYTES } from "./src/worker/limits.ts";

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

test("5 MB inbox budget is enforced in the insert WHERE clause", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE messages (id TEXT PRIMARY KEY, inbox_id TEXT, raw_size INTEGER)");
  const inbox = "box";
  db.run("INSERT INTO messages VALUES ('a', ?, ?)", [inbox, MAX_INBOX_BYTES - 100]);
  const allowed = db.run(
    `INSERT INTO messages (id, inbox_id, raw_size)
     SELECT ?, ?, ?
     WHERE (SELECT COALESCE(SUM(raw_size), 0) FROM messages WHERE inbox_id = ?) + ? <= ?`,
    ["b", inbox, 50, inbox, 50, MAX_INBOX_BYTES],
  );
  expect(allowed.changes).toBe(1);
  const refused = db.run(
    `INSERT INTO messages (id, inbox_id, raw_size)
     SELECT ?, ?, ?
     WHERE (SELECT COALESCE(SUM(raw_size), 0) FROM messages WHERE inbox_id = ?) + ? <= ?`,
    ["c", inbox, 200, inbox, 200, MAX_INBOX_BYTES],
  );
  expect(refused.changes).toBe(0);
});
