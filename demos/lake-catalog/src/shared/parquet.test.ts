import { expect, test } from "bun:test";
import { ORDER_ROWS } from "./rows";
import { readParquet, writeParquet } from "./parquet";
import { publishCatalog, seedIfNeeded } from "./sync";
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

test("a request seeds from embedded rows and only the cron writes Parquet", async () => {
  const objects = new Map<string, Uint8Array>();
  const puts: string[] = [];
  const lake = {
    async get(key: string) {
      const hit = objects.get(key);
      if (!hit) return null;
      const copy = hit;
      return { arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) };
    },
    async put(key: string, value: Uint8Array) {
      puts.push(key);
      objects.set(key, value);
    },
  };
  const sql = durableSql(new Database(":memory:"));
  const seeded = await seedIfNeeded(sql, lake, "orders", "2026-10-30");
  expect(seeded.source).toBe("embedded");
  expect(puts).toEqual([]);
  const again = await seedIfNeeded(sql, lake, "orders", "2026-10-30");
  expect(again.rows).toBe(ORDER_ROWS.length);
  expect(puts).toEqual([]);
  const published = await publishCatalog(sql, lake, "orders", "2026-10-30");
  expect(published.parquet).toBe(true);
  expect(puts).toEqual(["catalogs/orders/orders.parquet"]);
  const fromLake = await seedIfNeeded(sql, lake, "orders", "2026-10-31");
  expect(fromLake.source).toBe("r2");
  expect(puts).toEqual(["catalogs/orders/orders.parquet"]);
});
