import type { CatalogId, Column } from "./rows";
import { columnsFor, ORDER_ROWS, REGION_ROWS } from "./rows";
import type { Explain } from "./policy";

export type SqlExec = {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
};

export type QueryResult = {
  explain: Explain;
  rows: unknown[][];
};

export function ensureTable(sql: SqlExec, catalog: CatalogId): void {
  const columns = columnsFor(catalog);
  const defs = columns
    .map((column) => `${column.name} ${column.kind === "int" ? "INTEGER" : "TEXT"} NOT NULL`)
    .join(", ");
  sql.exec(`CREATE TABLE IF NOT EXISTS ${catalog} (${defs})`);
}

export function replaceRows(sql: SqlExec, catalog: CatalogId, rows: Record<string, unknown>[]): void {
  ensureTable(sql, catalog);
  sql.exec(`DELETE FROM ${catalog}`);
  const columns = columnsFor(catalog);
  const names = columns.map((column) => column.name).join(", ");
  const marks = columns.map(() => "?").join(", ");
  for (const row of rows) {
    sql.exec(
      `INSERT INTO ${catalog} (${names}) VALUES (${marks})`,
      ...columns.map((column) => row[column.name]),
    );
  }
}

export function seedEmbedded(sql: SqlExec, catalog: CatalogId): void {
  const rows = catalog === "orders" ? ORDER_ROWS : REGION_ROWS;
  replaceRows(sql, catalog, rows);
}

export function runExplained(sql: SqlExec, explain: Explain): QueryResult {
  if (explain.effect === "deny" || !explain.executedSql) return { explain, rows: [] };
  const table = sql.exec(explain.executedSql).toArray() as Record<string, unknown>[];
  const rows = table.map((row) => explain.columns.map((column: Column) => row[column.name] ?? null));
  return { explain, rows };
}
