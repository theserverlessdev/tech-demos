import { expect, test } from "bun:test";
import { ORDER_ROWS } from "./rows";
import { readParquet, writeParquet } from "./parquet";
import { syncCatalog } from "./sync";
import { durableSql } from "../../test/sql";
import { Database } from "bun:sqlite";

test("parquet round-trips the sample orders", async () => {
  const bytes = writeParquet("orders");
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("PAR1");
  const rows = await readParquet(bytes);
  expect(rows).toHaveLength(ORDER_ROWS.length);
  expect(rows[0]?.region).toBe("east");
  expect(rows.at(-1)?.customer).toBe("internal-lab");
  expect(Number(rows[0]?.units)).toBe(12);
});

test("sync writes the object when the bucket is empty and reads it back", async () => {
  const objects = new Map<string, Uint8Array>();
  const lake = {
    async get(key: string) {
      const hit = objects.get(key);
      if (!hit) return null;
      const copy = hit;
      return { arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) };
    },
    async put(key: string, value: Uint8Array) {
      objects.set(key, value);
    },
  };
  const sql = durableSql(new Database(":memory:"));
  const first = await syncCatalog(sql, lake, "orders", false);
  expect(first.parquet).toBe(true);
  expect(first.rows).toBe(ORDER_ROWS.length);
  expect(objects.size).toBe(1);
  const stored = [...objects.values()][0];
  expect(stored).toBeDefined();
  objects.set([...objects.keys()][0] ?? "", stored as Uint8Array);
  const second = await syncCatalog(sql, lake, "orders", false);
  expect(second.source).toBe("r2");
  const count = sql.exec("SELECT COUNT(*) AS n FROM orders").toArray()[0] as { n: number };
  expect(Number(count.n)).toBe(ORDER_ROWS.length);
});
