import { Database } from "bun:sqlite";
import { claimSql, DEFAULT_DAILY_CAP, ensureCapSchema } from "../src/shared/cap";
import { DEV_CONNECTION_SECRET, DEV_JWT_SECRET } from "../src/shared/jwt";
import { decide } from "../src/shared/policy";
import { ORDER_ROWS } from "../src/shared/rows";
import { runExplained, seedEmbedded, type SqlExec } from "../src/shared/sql";
import type { Deps } from "../src/worker/http";
import { DUMMY_TOKEN, verifyTurnstile } from "../src/worker/turnstile";
import { durableSql } from "../test/sql";

export function memoryDeps(): Deps {
  const sql: SqlExec = durableSql(new Database(":memory:"));
  seedEmbedded(sql, "orders");
  seedEmbedded(sql, "regions");
  const cap = durableSql(new Database(":memory:"));
  ensureCapSchema(cap);
  const now = Date.UTC(2026, 9, 30, 12, 0, 0);
  return {
    dev: true,
    siteKey: "0x4AAAAAAFRUoj5qDpf7XyIW",
    jwtSecret: DEV_JWT_SECRET,
    connectionSecret: DEV_CONNECTION_SECRET,
    bucket: "tech-demos-lake-catalog",
    ttlSeconds: 600,
    now: () => now,
    async limit() {
      return true;
    },
    verify: (token, ip) =>
      verifyTurnstile({
        secret: "1x0000000000000000000000000000000AA",
        token: token || DUMMY_TOKEN,
        ip,
        dev: true,
      }),
    async charge() {
      return claimSql(cap, new Date(now), DEFAULT_DAILY_CAP);
    },
    async resolveCatalog() {
      return true;
    },
    async queryCatalog(catalog, role, statement) {
      return runExplained(sql, decide(role, statement, catalog));
    },
    async status() {
      return {
        registryId: "registry-demo",
        catalogs: [
          {
            id: "orders",
            durableObjectId: "orders-do",
            dataPath: "r2://tech-demos-lake-catalog/catalogs/orders/",
            rows: ORDER_ROWS.length,
            parquet: true,
          },
          {
            id: "regions",
            durableObjectId: "regions-do",
            dataPath: "r2://tech-demos-lake-catalog/catalogs/regions/",
            rows: 4,
            parquet: true,
          },
        ],
      };
    },
    async reset() {
      seedEmbedded(sql, "orders");
    },
  };
}
