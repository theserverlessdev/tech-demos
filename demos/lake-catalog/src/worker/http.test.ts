import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { QuackClient } from "@quack-protocol/sdk";
import { claimSql, DEFAULT_DAILY_CAP, ensureCapSchema } from "../shared/cap";
import { DEV_CONNECTION_SECRET, DEV_JWT_SECRET } from "../shared/jwt";
import { decide } from "../shared/policy";
import { ORDER_ROWS } from "../shared/rows";
import { runExplained, seedEmbedded, type SqlExec } from "../shared/sql";
import { durableSql } from "../../test/sql";
import { DUMMY_TOKEN, verifyTurnstile } from "./turnstile";
import { rateLimitKey } from "./limits";
import { handleRequest, type Deps } from "./http";

function memory(): { deps: Deps; sql: SqlExec; clock: { now: number } } {
  const db = new Database(":memory:");
  const sql = durableSql(db);
  seedEmbedded(sql, "orders");
  seedEmbedded(sql, "regions");
  const capDb = durableSql(new Database(":memory:"));
  ensureCapSchema(capDb);
  const clock = { now: Date.UTC(2026, 9, 30, 12, 0, 0) };
  const deps: Deps = {
    dev: true,
    siteKey: "0x4AAAAAAFRUoj5qDpf7XyIW",
    jwtSecret: DEV_JWT_SECRET,
    connectionSecret: DEV_CONNECTION_SECRET,
    bucket: "tech-demos-lake-catalog",
    ttlSeconds: 600,
    now: () => clock.now,
    async limit() {
      return true;
    },
    verify: (token, ip) => verifyTurnstile({ secret: "1x0000000000000000000000000000000AA", token, ip, dev: deps.dev }),
    async charge() {
      return claimSql(capDb, new Date(clock.now), DEFAULT_DAILY_CAP);
    },
    async resolveCatalog() {
      return true;
    },
    async queryCatalog(catalog, role, statement) {
      const explain = decide(role, statement, catalog);
      return runExplained(sql, explain);
    },
    async status() {
      return {
        registryId: "registry-test",
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
      seedEmbedded(sql, "regions");
    },
  };
  return { deps, sql, clock };
}

function quackFetch(deps: Deps): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const response = await handleRequest(request, deps, url.pathname);
    return response ?? new Response("missing", { status: 404 });
  }) as typeof fetch;
}

test("viewer query over Quack rewrites and drops restricted rows", async () => {
  const { deps } = memory();
  const origin = "http://127.0.0.1";
  const minted = await handleRequest(
    new Request(`${origin}/api/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "viewer", turnstile: DUMMY_TOKEN, catalog: "orders" }),
    }),
    deps,
    "/api/token",
  );
  expect(minted?.status).toBe(200);
  const body = (await minted?.json()) as { token: string; snippet: string };
  expect(body.snippet).toContain(body.token);
  let explain: { effect?: string; executedSql?: string } | null = null;
  const client = await QuackClient.connect(origin, {
    authToken: body.token,
    heartbeat: false,
    fetch: async (input, init) => {
      const response = await quackFetch(deps)(input, init);
      const header = response.headers.get("x-lake-explain");
      if (header) explain = JSON.parse(header) as { effect?: string; executedSql?: string };
      return response;
    },
  });
  const result = await client.query("SELECT region, product, revenue, customer FROM orders");
  const rows = result.rows();
  await client.disconnect();
  expect(explain?.effect).toBe("rewrite");
  expect(explain?.executedSql).toContain("NULL AS customer");
  expect(rows).toHaveLength(8);
  expect(rows.some((row) => row.region === "restricted")).toBe(false);
  expect(rows[0]?.customer).toBeNull();
  expect(rows[0]?.revenue).toBe(240);
});

test("guest denial comes back as a Quack error with explain", async () => {
  const { deps } = memory();
  const origin = "http://127.0.0.1";
  const minted = await handleRequest(
    new Request(`${origin}/api/token`, {
      method: "POST",
      body: JSON.stringify({ role: "guest", turnstile: DUMMY_TOKEN }),
    }),
    deps,
    "/api/token",
  );
  const body = (await minted?.json()) as { token: string };
  let explain: { effect?: string } | null = null;
  const client = await QuackClient.connect(origin, {
    authToken: body.token,
    heartbeat: false,
    fetch: async (input, init) => {
      const response = await quackFetch(deps)(input, init);
      const header = response.headers.get("x-lake-explain");
      if (header) explain = JSON.parse(header) as { effect?: string };
      return response;
    },
  });
  await expect(client.query("SELECT customer, revenue FROM orders")).rejects.toThrow(/Guest cannot read/);
  await client.disconnect().catch(() => undefined);
  expect(explain?.effect).toBe("deny");
});

test("analyst sees the restricted customer and the map names both objects", async () => {
  const { deps } = memory();
  const origin = "http://127.0.0.1";
  const map = await handleRequest(new Request(`${origin}/api/map`), deps, "/api/map");
  const listed = (await map?.json()) as { catalogs: { id: string; durableObjectId: string }[] };
  expect(listed.catalogs.map((catalog) => catalog.durableObjectId)).toEqual(["orders-do", "regions-do"]);
  const minted = await handleRequest(
    new Request(`${origin}/api/token`, {
      method: "POST",
      body: JSON.stringify({ role: "analyst", turnstile: DUMMY_TOKEN }),
    }),
    deps,
    "/api/token",
  );
  const body = (await minted?.json()) as { token: string };
  const client = await QuackClient.connect(origin, { authToken: body.token, heartbeat: false, fetch: quackFetch(deps) });
  const rows = (await client.query("SELECT customer FROM orders WHERE region = 'restricted'")).rows();
  await client.disconnect();
  expect(rows.map((row) => row.customer)).toEqual(["internal-lab", "internal-lab"]);
});

test("production rejects the dummy token and a missing secret", async () => {
  const { deps } = memory();
  deps.dev = false;
  deps.jwtSecret = null;
  const origin = "http://lake-catalog.tech-demos.theserverless.dev";
  const blocked = await handleRequest(
    new Request(`${origin}/api/token`, {
      method: "POST",
      body: JSON.stringify({ role: "analyst", turnstile: DUMMY_TOKEN }),
    }),
    deps,
    "/api/token",
  );
  expect(blocked?.status).toBe(503);
  deps.jwtSecret = "real-jwt-secret";
  deps.connectionSecret = "real-connection-secret";
  const rejected = await handleRequest(
    new Request(`${origin}/api/token`, {
      method: "POST",
      body: JSON.stringify({ role: "analyst", turnstile: DUMMY_TOKEN }),
    }),
    deps,
    "/api/token",
  );
  expect(rejected?.status).toBe(401);
});

test("the daily cap stops the next query", async () => {
  const { deps } = memory();
  deps.charge = async () => ({ ok: false, used: 400, remaining: 0, cap: 400, resetsAt: "2026-10-31T00:00:00.000Z" });
  const origin = "http://127.0.0.1";
  const minted = await handleRequest(
    new Request(`${origin}/api/token`, {
      method: "POST",
      body: JSON.stringify({ role: "analyst", turnstile: DUMMY_TOKEN }),
    }),
    deps,
    "/api/token",
  );
  const body = (await minted?.json()) as { token: string };
  let explain: { reasons?: string[] } | null = null;
  const client = await QuackClient.connect(origin, {
    authToken: body.token,
    heartbeat: false,
    fetch: async (input, init) => {
      const response = await quackFetch(deps)(input, init);
      const header = response.headers.get("x-lake-explain");
      if (header) explain = JSON.parse(header) as { reasons?: string[] };
      return response;
    },
  });
  await expect(client.query("SELECT region FROM orders")).rejects.toThrow(/400 queries today/);
  await client.disconnect().catch(() => undefined);
  expect(explain?.reasons?.[0]).toContain("midnight UTC");
});

test("ipv6 rate limit keys share a /64", () => {
  expect(rateLimitKey("2001:db8:abcd:0012:0000:0000:0000:0001")).toBe("2001:0db8:abcd:0012::/64");
  expect(rateLimitKey("203.0.113.9")).toBe("203.0.113.9");
});
