import { DurableObject } from "cloudflare:workers";
import { claimSql, DEFAULT_DAILY_CAP, ensureCapSchema, type ClaimResult } from "../shared/cap";
import { CATALOGS, type CatalogId } from "../shared/rows";
import { isCatalog } from "../shared/policy";
import type { Env } from "./env";

function capOf(env: Env): number {
  const parsed = Number(env.DAILY_QUERY_CAP);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_CAP;
}

/** One global registry. It knows the catalog ids and the daily query counter. */
export class CatalogRegistry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ensureCapSchema(ctx.storage.sql);
      for (const id of CATALOGS) {
        ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS catalogs (id TEXT PRIMARY KEY)");
        ctx.storage.sql.exec("INSERT INTO catalogs (id) VALUES (?) ON CONFLICT(id) DO NOTHING", id);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/resolve" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { catalog?: string } | null;
      const catalog = body?.catalog ?? "";
      if (!isCatalog(catalog)) return Response.json({ ok: false }, { status: 404 });
      const row = this.ctx.storage.sql.exec("SELECT id FROM catalogs WHERE id = ?", catalog).toArray()[0] as
        | { id: string }
        | undefined;
      if (!row) return Response.json({ ok: false }, { status: 404 });
      return Response.json({ ok: true, catalog: row.id as CatalogId });
    }
    if (url.pathname === "/charge" && request.method === "POST") {
      const result = await this.ctx.blockConcurrencyWhile(async () => claimSql(this.ctx.storage.sql, new Date(), capOf(this.env)));
      return Response.json(result satisfies ClaimResult);
    }
    return new Response("Not found", { status: 404 });
  }
}
