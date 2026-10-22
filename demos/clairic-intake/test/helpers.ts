import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

export function memoryDb(): Database {
  const db = new Database(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  return db;
}

export function asD1(db: Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
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
  } as unknown as D1Database;
}
