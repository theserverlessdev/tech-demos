import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { countSqlPlaceholders } from "./src/shared/scan.ts";
import { CLEANUP_DELETE_INBOXES_SQL, CLEANUP_DELETE_MESSAGES_SQL } from "./src/worker/db.ts";
import { CLEANUP_PAGE, D1_MAX_BOUND_PARAMS } from "./src/worker/limits.ts";

test("cleanup deletes bind one JSON parameter, under the D1 cap", () => {
  expect(countSqlPlaceholders(CLEANUP_DELETE_MESSAGES_SQL)).toBe(1);
  expect(countSqlPlaceholders(CLEANUP_DELETE_INBOXES_SQL)).toBe(1);
  expect(countSqlPlaceholders(CLEANUP_DELETE_MESSAGES_SQL)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
  expect(CLEANUP_PAGE).toBeGreaterThan(D1_MAX_BOUND_PARAMS);
});

test("json_each deletes 200 inbox ids with a single bind", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE inboxes (id TEXT PRIMARY KEY)");
  db.run("CREATE TABLE messages (id TEXT PRIMARY KEY, inbox_id TEXT)");
  const ids = Array.from({ length: 200 }, (_, i) => `inbox-${i}`);
  for (const id of ids) {
    db.run("INSERT INTO inboxes (id) VALUES (?)", [id]);
    db.run("INSERT INTO messages (id, inbox_id) VALUES (?, ?)", [`m-${id}`, id]);
  }
  const payload = JSON.stringify(ids);
  db.run(CLEANUP_DELETE_MESSAGES_SQL, [payload]);
  db.run(CLEANUP_DELETE_INBOXES_SQL, [payload]);
  expect(db.query("SELECT COUNT(*) AS n FROM inboxes").get() as { n: number }).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).toEqual({ n: 0 });
});
