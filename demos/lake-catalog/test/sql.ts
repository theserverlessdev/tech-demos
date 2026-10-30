import { Database } from "bun:sqlite";
import type { SqlExec } from "../src/shared/sql";

/** bun:sqlite shaped like Durable Object storage.sql for the statements this demo runs. */
export function durableSql(db: Database): SqlExec {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const statement = db.query(query);
      const upper = query.trimStart().toUpperCase();
      if (upper.startsWith("SELECT") || upper.startsWith("PRAGMA")) {
        const rows = statement.all(...(bindings as never[]));
        return { toArray: () => rows };
      }
      statement.run(...(bindings as never[]));
      return { toArray: () => [] };
    },
  };
}
