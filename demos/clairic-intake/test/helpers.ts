import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

export function memoryDb(): Database {
  const db = new Database(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of ["0001_init.sql", "0002_inbox_state.sql"]) {
    db.exec(readFileSync(new URL(name, dir), "utf8"));
  }
  return db;
}

export function asD1(db: Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
        sql,
        args: [] as unknown[],
        bind(...args: unknown[]) {
          statement.args = args;
          return statement;
        },
        async run() {
          const info = db.query(sql).run(...(statement.args as never[]));
          return { success: true, meta: { changes: info.changes } };
        },
        async first<T>() {
          return (db.query(sql).get(...(statement.args as never[])) as T | null) ?? null;
        },
        async all<T>() {
          return { results: db.query(sql).all(...(statement.args as never[])) as T[] };
        },
      };
      return statement;
    },
    async batch(statements: { sql: string; args: unknown[] }[]) {
      const txn = db.transaction(() =>
        statements.map((statement) => {
          const info = db.query(statement.sql).run(...(statement.args as never[]));
          return { success: true, meta: { changes: info.changes }, results: [] };
        }),
      );
      return txn();
    },
  } as unknown as D1Database;
}
