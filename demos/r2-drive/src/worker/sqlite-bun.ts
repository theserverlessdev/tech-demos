import { Database } from "bun:sqlite";
import type { SqlRunner } from "./quota";

/** Bun's SQLite speaks the same `?` placeholders and RETURNING rows as DO storage. */
export function bunSql(db: Database): SqlRunner {
  return {
    exec(query, ...bindings) {
      const statement = db.query(query);
      const returns = /^\s*(select|with)\b/i.test(query) || /\breturning\b/i.test(query);
      if (!returns) {
        statement.run(...bindings);
        return { toArray: () => [] as Record<string, unknown>[] };
      }
      const rows = statement.all(...bindings);
      return { toArray: () => rows };
    },
  };
}
