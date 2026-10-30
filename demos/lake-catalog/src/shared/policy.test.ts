import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { decide, type Role } from "./policy";
import { runExplained, seedEmbedded } from "./sql";
import { durableSql } from "../../test/sql";

test("analyst reads every orders column", () => {
  const explain = decide("analyst", "SELECT region, product, units, revenue, customer FROM orders", "orders");
  expect(explain.effect).toBe("allow");
  expect(explain.executedSql).toBe("SELECT region, product, units, revenue, customer FROM orders");
  expect(explain.columns.map((column) => column.name)).toEqual(["region", "product", "units", "revenue", "customer"]);
});

test("viewer masks customer and hides restricted rows", () => {
  const explain = decide("viewer", "SELECT region, product, revenue, customer FROM orders", "orders");
  expect(explain.effect).toBe("rewrite");
  expect(explain.executedSql).toBe(
    "SELECT region, product, revenue, NULL AS customer FROM orders WHERE region <> 'restricted'",
  );
  expect(explain.reasons.join(" ")).toContain("customer");
  expect(explain.reasons.join(" ")).toContain("restricted");
});

test("guest is denied when the statement names revenue or customer", () => {
  const explain = decide("guest", "SELECT customer, revenue FROM orders", "orders");
  expect(explain.effect).toBe("deny");
  expect(explain.executedSql).toBeNull();
  expect(explain.reasons[0]).toContain("customer");
  expect(explain.reasons[0]).toContain("revenue");
});

test("guest star narrows to public columns and drops restricted rows", () => {
  const explain = decide("guest", "SELECT * FROM orders", "orders");
  expect(explain.effect).toBe("rewrite");
  expect(explain.executedSql).toBe(
    "SELECT region, product, units FROM orders WHERE region <> 'restricted'",
  );
});

test("a second statement and writes are denied without running", () => {
  expect(decide("analyst", "SELECT region FROM orders; DROP TABLE orders", "orders").effect).toBe("deny");
  expect(decide("analyst", "DELETE FROM orders", "orders").effect).toBe("deny");
  expect(decide("analyst", "SELECT region FROM orders WHERE region = 'east' OR 1=1", "orders").effect).toBe("deny");
  expect(decide("analyst", "SELECT region FROM sqlite_master", "orders").effect).toBe("deny");
});

test("viewer keeps a safe filter and still adds the row rule", () => {
  const explain = decide("viewer", "SELECT region FROM orders WHERE region = 'east'", "orders");
  expect(explain.effect).toBe("rewrite");
  expect(explain.executedSql).toBe("SELECT region FROM orders WHERE region = 'east' AND region <> 'restricted'");
});

test("regions is readable for every role", () => {
  expect(decide("guest", "SELECT region, offices FROM regions", "regions").effect).toBe("allow");
  expect(decide("guest", "SELECT customer FROM regions", "regions").effect).toBe("deny");
});

test("a filter on a hidden or masked column is denied", () => {
  expect(decide("viewer", "SELECT region FROM orders WHERE customer = 'acme'", "orders").executedSql).toBeNull();
  expect(decide("viewer", "SELECT region FROM orders WHERE CUSTOMER = 'acme'", "orders").executedSql).toBeNull();
  expect(decide("guest", "SELECT region FROM orders WHERE revenue = 240", "orders").executedSql).toBeNull();
  expect(decide("guest", "SELECT region, product, units FROM orders WHERE customer = 'acme'", "orders").executedSql).toBeNull();
  const viewerRevenue = decide("viewer", "SELECT region FROM orders WHERE revenue = 240", "orders");
  expect(viewerRevenue.executedSql).toBe(
    "SELECT region FROM orders WHERE revenue = 240 AND region <> 'restricted'",
  );
});

test("guest rows and columns are a subset of the viewer result", () => {
  const sql = durableSql(new Database(":memory:"));
  seedEmbedded(sql, "orders");
  const viewer = runExplained(sql, decide("viewer", "SELECT * FROM orders", "orders"));
  const guest = runExplained(sql, decide("guest", "SELECT * FROM orders", "orders"));
  const viewerNames = viewer.explain.columns.map((column) => column.name);
  const guestNames = guest.explain.columns.map((column) => column.name);
  expect(guestNames.every((name) => viewerNames.includes(name))).toBe(true);
  expect(guestNames).not.toContain("customer");
  expect(guestNames).not.toContain("revenue");
  const projected = viewer.rows.map((row) => guestNames.map((name) => row[viewerNames.indexOf(name)]));
  const guestKeys = new Set(guest.rows.map((row) => JSON.stringify(row)));
  expect(guest.rows.length).toBeLessThanOrEqual(viewer.rows.length);
  expect([...guestKeys].every((key) => projected.some((row) => JSON.stringify(row) === key))).toBe(true);
  expect(guest.rows.some((row) => row[guestNames.indexOf("region")] === "restricted")).toBe(false);
  expect(viewer.rows.some((row) => row[viewerNames.indexOf("region")] === "restricted")).toBe(false);
});

test("bypasses do not change the SQL that runs", () => {
  const cases: { role: Role; sql: string; executedSql: string | null }[] = [
    { role: "analyst", sql: "SELECT region FROM orders -- hide", executedSql: null },
    { role: "analyst", sql: "SELECT region FROM orders /* hide */", executedSql: null },
    { role: "guest", sql: 'SELECT "customer" FROM orders', executedSql: null },
    {
      role: "viewer",
      sql: "SELECT CUSTOMER FROM orders",
      executedSql: "SELECT NULL AS customer FROM orders WHERE region <> 'restricted'",
    },
    { role: "guest", sql: "SELECT CUSTOMER FROM orders", executedSql: null },
    { role: "guest", sql: "SELECT customer AS c FROM orders", executedSql: null },
    { role: "guest", sql: "SELECT orders.customer FROM orders", executedSql: null },
    { role: "guest", sql: "SELECT upper(customer) FROM orders", executedSql: null },
    { role: "guest", sql: "SELECT customer || '' FROM orders", executedSql: null },
    { role: "analyst", sql: "SELECT region FROM orders UNION SELECT region FROM orders", executedSql: null },
    { role: "analyst", sql: "WITH t AS (SELECT customer FROM orders) SELECT * FROM t", executedSql: null },
    { role: "analyst", sql: "SELECT region FROM orders WHERE region IN (SELECT region FROM orders)", executedSql: null },
    { role: "analyst", sql: "SELECT region FROM (SELECT customer FROM orders)", executedSql: null },
    { role: "analyst", sql: "SELECT region FROM orders WHERE region LIKE 'east'", executedSql: null },
    { role: "analyst", sql: "PRAGMA table_info(orders)", executedSql: null },
    { role: "analyst", sql: "ATTACH 'lake' AS extra", executedSql: null },
    { role: "analyst", sql: "SELECT region FROM orders WHERE product = 'a;b'", executedSql: null },
    { role: "analyst", sql: "SELECT region FROM orders LIMIT 0", executedSql: null },
    { role: "analyst", sql: "SELECT region FROM orders LIMIT 101", executedSql: null },
  ];
  for (const sample of cases) {
    expect(decide(sample.role, sample.sql, "orders").executedSql).toBe(sample.executedSql);
  }
});
