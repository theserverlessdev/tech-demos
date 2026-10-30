import { parquetKey, type CatalogId } from "./rows";
import { embeddedRows, readParquet, writeParquet } from "./parquet";
import { replaceRows, type SqlExec } from "./sql";

export type LakeStore = {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, value: Uint8Array): Promise<unknown>;
};

export type SyncResult = { rows: number; parquet: boolean; source: "r2" | "embedded" };

/**
 * Make the catalog table match its Parquet object.
 * A missing object is written from the embedded sample. A read failure keeps the sample and reports parquet false.
 */
export async function syncCatalog(
  sql: SqlExec,
  lake: LakeStore | null,
  catalog: CatalogId,
  force = false,
): Promise<SyncResult> {
  let rows = embeddedRows(catalog);
  let parquet = false;
  let source: SyncResult["source"] = "embedded";
  if (lake) {
    try {
      if (!force) {
        const existing = await lake.get(parquetKey(catalog));
        if (existing) {
          const read = await readParquet(new Uint8Array(await existing.arrayBuffer()));
          if (read.length) {
            rows = read;
            parquet = true;
            source = "r2";
          }
        }
      }
      if (!parquet) {
        await lake.put(parquetKey(catalog), writeParquet(catalog, embeddedRows(catalog)));
        rows = embeddedRows(catalog);
        parquet = true;
        source = force ? "embedded" : source;
        if (!force) source = "embedded";
      }
    } catch (err) {
      console.log(JSON.stringify({ event: "r2_unavailable", catalog, name: err instanceof Error ? err.name : "error" }));
      rows = embeddedRows(catalog);
      parquet = false;
      source = "embedded";
    }
  }
  replaceRows(sql, catalog, rows);
  return { rows: rows.length, parquet, source };
}
