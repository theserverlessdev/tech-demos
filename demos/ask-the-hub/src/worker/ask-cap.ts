import { DurableObject } from "cloudflare:workers";
import { claimDay, type Counter, type ClaimResult } from "./cap";
import type { Env } from "./env";

function sqlCounter(ctx: DurableObjectState): Counter {
  return {
    get(day) {
      const row = ctx.storage.sql.exec("SELECT count AS n FROM asks WHERE day = ?", day).toArray()[0] as
        | { n: number }
        | undefined;
      return row ? Number(row.n) : 0;
    },
    set(day, count) {
      ctx.storage.sql.exec(
        "INSERT INTO asks (day, count) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET count = excluded.count",
        day,
        count,
      );
    },
  };
}

/** One global SQLite counter. The name on the stub is `global`. */
export class AskCap extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS asks (day TEXT PRIMARY KEY, count INTEGER NOT NULL)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, exp INTEGER NOT NULL)");
    });
  }

  async claim(nowMs?: number): Promise<ClaimResult> {
    const now = new Date(typeof nowMs === "number" ? nowMs : Date.now());
    return this.ctx.blockConcurrencyWhile(() => claimDay(sqlCounter(this.ctx), now));
  }

  /** Remember a token hash for two minutes so search and ask can share one check. */
  async rememberToken(hash: string, nowMs?: number): Promise<void> {
    const now = typeof nowMs === "number" ? nowMs : Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO tokens (hash, exp) VALUES (?, ?) ON CONFLICT(hash) DO UPDATE SET exp = excluded.exp",
      hash,
      now + 120_000,
    );
    this.ctx.storage.sql.exec("DELETE FROM tokens WHERE exp < ?", now);
  }

  async knownToken(hash: string, nowMs?: number): Promise<boolean> {
    const now = typeof nowMs === "number" ? nowMs : Date.now();
    const row = this.ctx.storage.sql.exec("SELECT exp FROM tokens WHERE hash = ?", hash).toArray()[0] as
      | { exp: number }
      | undefined;
    return !!row && Number(row.exp) > now;
  }
}

export function askCap(env: Env): DurableObjectStub {
  return env.ASK_CAP.getByName("global");
}
