import { DurableObject } from "cloudflare:workers";
import { utcDay } from "../shared/cap";
import { decide, isCatalog, isRole } from "../shared/policy";
import { runExplained, type QueryResult } from "../shared/sql";
import { catalogCount, publishCatalog, seedIfNeeded } from "../shared/sync";
import type { Env } from "./env";
import { readCappedBytes } from "./http";

const MAX_SQL = 2000;

/** One SQLite database per catalog. The name arrives on the request from idFromName. */
export class QuackCatalog extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const catalog = url.searchParams.get("catalog") ?? "";
    if (!isCatalog(catalog)) return Response.json({ error: "Unknown catalog." }, { status: 400 });
    if (url.pathname === "/status" && request.method === "GET") {
      return Response.json({ rows: catalogCount(this.ctx.storage.sql, catalog) });
    }
    if (url.pathname === "/reset" && request.method === "POST") {
      const synced = await publishCatalog(this.ctx.storage.sql, this.env.LAKE, catalog, utcDay(new Date()));
      console.log(JSON.stringify({ event: "catalog_reset", catalog, source: synced.source, rows: synced.rows }));
      return Response.json(synced);
    }
    if (url.pathname === "/query" && request.method === "POST") {
      const raw = await readCappedBytes(request, 8_000);
      if (raw instanceof Response) return raw;
      let body: { role?: string; sql?: string } | null = null;
      try {
        body = JSON.parse(new TextDecoder().decode(raw) || "null") as { role?: string; sql?: string } | null;
      } catch {
        body = null;
      }
      const role = body?.role ?? "";
      const sql = typeof body?.sql === "string" ? body.sql : "";
      if (!isRole(role)) return Response.json({ error: "Unknown role." }, { status: 400 });
      if (sql.length > MAX_SQL) {
        const explain = decide(role, "SELECT", catalog);
        explain.effect = "deny";
        explain.reasons = ["The query is too long."];
        explain.executedSql = null;
        explain.columns = [];
        return Response.json({ explain, rows: [] } satisfies QueryResult);
      }
      await seedIfNeeded(this.ctx.storage.sql, this.env.LAKE, catalog, utcDay(new Date()));
      const explain = decide(role, sql, catalog);
      let result: QueryResult = { explain, rows: [] };
      if (explain.effect !== "deny" && explain.executedSql) {
        try {
          result = runExplained(this.ctx.storage.sql, explain);
        } catch (err) {
          console.log(JSON.stringify({ event: "query_failed", catalog, role, name: err instanceof Error ? err.name : "error" }));
          result = {
            explain: { ...explain, effect: "deny", reasons: ["The statement could not run."], executedSql: null, columns: [] },
            rows: [],
          };
        }
      }
      console.log(JSON.stringify({ event: "query", catalog, role, effect: result.explain.effect }));
      return Response.json(result);
    }
    return new Response("Not found", { status: 404 });
  }
}
