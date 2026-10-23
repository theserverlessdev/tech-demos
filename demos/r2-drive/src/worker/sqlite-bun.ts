import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { SqlRunner } from "./quota";

/** Bun's SQLite speaks the same `?` placeholders and RETURNING rows as DO storage. */
export function bunSql(db: Database): SqlRunner {
  return {
    exec(query, ...bindings) {
      const statement = db.query(query);
      const params = bindings as SQLQueryBindings[];
      const returns = /^\s*(select|with)\b/i.test(query) || /\breturning\b/i.test(query);
      if (!returns) {
        statement.run(...params);
        return { toArray: () => [] as Record<string, unknown>[] };
      }
      const rows = statement.all(...params) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  };
}
