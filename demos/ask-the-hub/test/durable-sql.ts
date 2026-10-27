import { Database } from "bun:sqlite";

/**
 * bun:sqlite counts table rows only. Durable Object SQLite also counts each
 * index write ("every row update of an index counts as an additional row"),
 * so a primary-key insert reports rowsWritten 2. RETURNING still yields the row.
 */
export function durableSql(db: Database) {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const statement = db.query(query);
      const upper = query.trimStart().toUpperCase();
      const returning = /\bRETURNING\b/i.test(query);
      if ((upper.startsWith("SELECT") || upper.startsWith("PRAGMA")) && !returning) {
        const rows = statement.all(...(bindings as never[]));
        return { toArray: () => rows, get rowsWritten() { return 0; } };
      }
      if (returning) {
        const rows = statement.all(...(bindings as never[]));
        const changes = changesOf(db);
        const written = durableRowsWritten(db, query, changes);
        return { toArray: () => rows, get rowsWritten() { return written; } };
      }
      const changes = statement.run(...(bindings as never[])).changes;
      const written = durableRowsWritten(db, query, changes);
      return { toArray: () => [], get rowsWritten() { return written; } };
    },
  };
}

function changesOf(db: Database): number {
  const row = db.query("SELECT changes() AS n").get() as { n: number } | null;
  return row ? Number(row.n) : 0;
}

function durableRowsWritten(db: Database, query: string, changes: number): number {
  if (changes <= 0) return 0;
  const kind = query.trimStart().match(/^(insert|update|delete|replace)\b/i)?.[1]?.toLowerCase();
  const table = query.match(/\b(?:INTO|UPDATE|FROM)\s+([A-Za-z_][A-Za-z0-9_]*)/i)?.[1];
  if (!kind || !table) return changes;
  const indexes = db.query(`PRAGMA index_list(${table})`).all() as { name: string }[];
  const assigned = new Set(
    [...query.matchAll(/\bSET\b([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|$)/gi)].flatMap((part) =>
      [...part[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=/g)].map((column) => column[1].toLowerCase()),
    ),
  );
  let indexesPerRow = 0;
  for (const index of indexes) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(index.name)) continue;
    if (kind === "update") {
      const columns = db.query(`PRAGMA index_info(${index.name})`).all() as { name: string | null }[];
      if (columns.some((column) => column.name && assigned.has(column.name.toLowerCase()))) indexesPerRow += 1;
    } else {
      indexesPerRow += 1;
    }
  }
  return changes + changes * indexesPerRow;
}
