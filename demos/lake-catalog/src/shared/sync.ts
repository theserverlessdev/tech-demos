import { utcDay } from "./cap";
import { parquetKey, type CatalogId } from "./rows";
import { embeddedRows, readParquet, writeParquet } from "./parquet";
import { replaceRows, type SqlExec } from "./sql";

export type LakeStore = {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, value: Uint8Array): Promise<unknown>;
};

export type SyncResult = { rows: number; parquet: boolean; source: "r2" | "embedded" };

function markerKey(catalog: CatalogId): string {
  return `seeded_day:${catalog}`;
}

function rowsOf(sql: SqlExec, query: string, ...bindings: unknown[]): unknown[] | null {
  try {
    return sql.exec(query, ...bindings).toArray();
  } catch {
    return null;
  }
}

function seededDay(sql: SqlExec, catalog: CatalogId): string | null {
  const rows = rowsOf(sql, "SELECT value AS v FROM catalog_meta WHERE key = ?", markerKey(catalog));
  const row = rows?.[0] as { v?: string } | undefined;
  return row?.v ?? null;
}

function remember(sql: SqlExec, catalog: CatalogId, day: string): void {
  sql.exec("CREATE TABLE IF NOT EXISTS catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  sql.exec(
    "INSERT INTO catalog_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    markerKey(catalog),
    day,
  );
}

function rowCount(sql: SqlExec, catalog: CatalogId): number | null {
  const rows = rowsOf(sql, `SELECT COUNT(*) AS n FROM ${catalog}`);
  const row = rows?.[0] as { n?: number } | undefined;
  if (!row) return null;
  return Number(row.n ?? 0);
}

export function catalogCount(sql: SqlExec, catalog: CatalogId): number {
  return rowCount(sql, catalog) ?? 0;
}

/** Read Parquet when it is already there. A miss or a read error uses the embedded sample and does not write. */
async function loadRows(lake: LakeStore | null, catalog: CatalogId): Promise<{ rows: Record<string, unknown>[]; parquet: boolean }> {
  if (!lake) return { rows: embeddedRows(catalog), parquet: false };
  try {
    const existing = await lake.get(parquetKey(catalog));
    if (existing) {
      const read = await readParquet(new Uint8Array(await existing.arrayBuffer()));
      if (read.length) return { rows: read, parquet: true };
    }
  } catch (err) {
    console.log(JSON.stringify({ event: "r2_unavailable", catalog, name: err instanceof Error ? err.name : "error" }));
  }
  return { rows: embeddedRows(catalog), parquet: false };
}

export function isFresh(sql: SqlExec, catalog: CatalogId, day = utcDay(new Date())): boolean {
  const count = rowCount(sql, catalog);
  if (count === null || count === 0) return false;
  return seededDay(sql, catalog) === day;
}

/** Fill SQLite only when the table is empty or the UTC day marker is stale. Never calls lake.put. */
export async function seedIfNeeded(
  sql: SqlExec,
  lake: LakeStore | null,
  catalog: CatalogId,
  day = utcDay(new Date()),
): Promise<SyncResult> {
  if (isFresh(sql, catalog, day)) {
    return { rows: rowCount(sql, catalog) ?? 0, parquet: false, source: "embedded" };
  }
  const loaded = await loadRows(lake, catalog);
  replaceRows(sql, catalog, loaded.rows);
  remember(sql, catalog, day);
  return { rows: loaded.rows.length, parquet: loaded.parquet, source: loaded.parquet ? "r2" : "embedded" };
}

/** Cron path. This is the only place that writes the Parquet object. */
export async function publishCatalog(
  sql: SqlExec,
  lake: LakeStore | null,
  catalog: CatalogId,
  day = utcDay(new Date()),
): Promise<SyncResult> {
  const rows = embeddedRows(catalog);
  let parquet = false;
  if (lake) {
    try {
      await lake.put(parquetKey(catalog), writeParquet(catalog, rows));
      parquet = true;
    } catch (err) {
      console.log(JSON.stringify({ event: "r2_unavailable", catalog, name: err instanceof Error ? err.name : "error" }));
    }
  }
  replaceRows(sql, catalog, rows);
  remember(sql, catalog, day);
  return { rows: rows.length, parquet, source: "embedded" };
}
