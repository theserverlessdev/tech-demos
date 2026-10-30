import { parquetReadObjects } from "hyparquet";
import { parquetWriteBuffer } from "hyparquet-writer";
import { ORDER_ROWS, REGION_ROWS, columnsFor, type CatalogId } from "./rows";

type ColumnData = { name: string; data: (string | number)[]; type: "STRING" | "INT32" };

function columnData(catalog: CatalogId, rows: Record<string, unknown>[]): ColumnData[] {
  return columnsFor(catalog).map((column) => ({
    name: column.name,
    type: column.kind === "int" ? "INT32" : "STRING",
    data: rows.map((row) => row[column.name] as string | number),
  }));
}

export function embeddedRows(catalog: CatalogId): Record<string, unknown>[] {
  return catalog === "orders" ? ORDER_ROWS : REGION_ROWS;
}

/** Uncompressed Parquet so the Worker can read it without a Snappy module. */
export function writeParquet(catalog: CatalogId, rows: Record<string, unknown>[] = embeddedRows(catalog)): Uint8Array {
  const buffer = parquetWriteBuffer({
    columnData: columnData(catalog, rows),
    codec: "UNCOMPRESSED",
  });
  return new Uint8Array(buffer);
}

export async function readParquet(bytes: Uint8Array): Promise<Record<string, unknown>[]> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const rows = await parquetReadObjects({ file: copy });
  return rows;
}
