import { expect, test } from "bun:test";
import { decide } from "./policy";

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

test("guest star narrows to public columns", () => {
  const explain = decide("guest", "SELECT * FROM orders", "orders");
  expect(explain.effect).toBe("rewrite");
  expect(explain.executedSql).toBe("SELECT region, product, units FROM orders");
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
