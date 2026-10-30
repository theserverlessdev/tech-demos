import { DurableObject } from "cloudflare:workers";
import { decide, isCatalog, isRole } from "../shared/policy";
import { runExplained, type QueryResult } from "../shared/sql";
import { syncCatalog } from "../shared/sync";
import type { CatalogId } from "../shared/rows";
import type { Env } from "./env";

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
      const synced = await syncCatalog(this.ctx.storage.sql, this.env.LAKE, catalog, false);
      return Response.json(synced);
    }
    if (url.pathname === "/reset" && request.method === "POST") {
      const synced = await syncCatalog(this.ctx.storage.sql, this.env.LAKE, catalog, true);
      console.log(JSON.stringify({ event: "catalog_reset", catalog, source: synced.source, rows: synced.rows }));
      return Response.json(synced);
    }
    if (url.pathname === "/query" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { role?: string; sql?: string } | null;
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
      await syncCatalog(this.ctx.storage.sql, this.env.LAKE, catalog, false);
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
