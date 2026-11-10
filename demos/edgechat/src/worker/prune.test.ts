import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { pruneOldData } from "./prune";

type Bound = { sql: string; args: unknown[] };

function memory(): { db: Database; log: Bound[]; env: Env } {
  const db = new Database(":memory:");
  const dir = new URL("../../migrations/", import.meta.url);
  for (const name of ["0001_init.sql", "0002_author_key.sql", "0003_redact_session_id.sql"]) {
    db.exec(readFileSync(new URL(name, dir), "utf8"));
  }
  const log: Bound[] = [];
  const d1 = {
    prepare(sql: string) {
      const statement = {
        sql,
        args: [] as unknown[],
        bind(...args: unknown[]) {
          statement.args = args;
          return statement;
        },
        async run() {
          log.push({ sql, args: statement.args });
          const info = db.query(sql).run(...(statement.args as never[]));
          return { success: true, meta: { changes: info.changes } };
        },
        async all<T>() {
          log.push({ sql, args: statement.args });
          return { results: db.query(sql).all(...(statement.args as never[])) as T[] };
        },
      };
      return statement;
    },
    async batch(statements: { run: () => Promise<{ success: boolean; meta: { changes: number } }> }[]) {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      return out;
    },
  };
  const env = {
    DB: d1,
    FILES: { async delete() {} },
  } as unknown as Env;
  return { db, log, env };
}

test("prune deletes more than 100 due rows in batches under the D1 parameter cap", async () => {
  const { db, log, env } = memory();
  const now = Date.parse("2026-11-10T12:00:00Z");
  const old = now - 8 * 24 * 60 * 60 * 1000;
  const young = now - 60_000;
  db.exec(`INSERT INTO rooms (id, name, created_at, last_message_at, last_preview, message_count) VALUES
    ('spam', 'spam', ${old}, ${old}, '', 120),
    ('fresh', 'fresh', ${young}, 0, '', 0),
    ('empty-old', 'empty-old', ${old}, 0, '', 0)`);
  const insert = db.query(
    "INSERT INTO messages (id, room_id, author, session_id, body, attachment_id, created_at, author_key) VALUES (?, 'spam', 'Ada', 'redacted', 'due', NULL, ?, 'ada')",
  );
  const write = db.transaction(() => {
    for (let i = 0; i < 120; i++) insert.run(`msg_due_${i}`, old + i);
  });
  write();
  db.exec(`INSERT INTO attachments (id, room_id, r2_key, filename, content_type, size, created_at) VALUES
    ('att_old', 'spam', 'uploads/old.bin', 'old.bin', 'application/octet-stream', 1, ${now - 11 * 60 * 1000}),
    ('att_new', 'fresh', 'uploads/new.bin', 'new.bin', 'application/octet-stream', 1, ${young})`);

  const result = await pruneOldData(env, now);

  expect(result.deletedMessages).toBe(120);
  expect(db.query("SELECT COUNT(*) AS n FROM messages WHERE id NOT LIKE 'msg_lobby_%'").get()).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM messages WHERE id LIKE 'msg_lobby_%'").get()).toEqual({ n: 2 });
  expect(db.query("SELECT id FROM rooms WHERE id = 'fresh'").get()).toEqual({ id: "fresh" });
  expect(db.query("SELECT id FROM rooms WHERE id = 'empty-old'").get()).toBeNull();
  expect(db.query("SELECT id FROM rooms WHERE id = 'spam'").get()).toBeNull();
  expect(db.query("SELECT id FROM attachments WHERE id = 'att_new'").get()).toEqual({ id: "att_new" });
  expect(db.query("SELECT id FROM attachments WHERE id = 'att_old'").get()).toBeNull();

  const messageDeletes = log.filter((entry) => entry.sql.startsWith("DELETE FROM messages"));
  expect(messageDeletes.length).toBeGreaterThan(1);
  for (const entry of log) {
    const placeholders = entry.sql.match(/\?/g)?.length ?? 0;
    expect(placeholders).toBeLessThanOrEqual(91);
    expect(entry.args.length).toBeLessThanOrEqual(91);
  }
});
