import { DurableObject } from "cloudflare:workers";
import {
  DAILY_CAP,
  SEARCH_DAILY_CAP,
  claimSql,
  ensureCapSchema,
  refundSql,
  rememberSql,
  takeSql,
  type CapSql,
  type ClaimResult,
  type TokenDecision,
} from "./cap";
import type { Env } from "./env";

function sqlOf(ctx: DurableObjectState): CapSql {
  return ctx.storage.sql;
}

/** One global SQLite counter. The name on the stub is `global`. */
export class AskCap extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ensureCapSchema(sqlOf(ctx));
    });
  }

  async claim(nowMs?: number): Promise<ClaimResult> {
    const now = new Date(typeof nowMs === "number" ? nowMs : Date.now());
    return this.ctx.blockConcurrencyWhile(async () => claimSql(sqlOf(this.ctx), "asks", now, DAILY_CAP));
  }

  async claimSearch(nowMs?: number): Promise<ClaimResult> {
    const now = new Date(typeof nowMs === "number" ? nowMs : Date.now());
    return this.ctx.blockConcurrencyWhile(async () => claimSql(sqlOf(this.ctx), "searches", now, SEARCH_DAILY_CAP));
  }

  async refund(nowMs?: number): Promise<void> {
    const now = new Date(typeof nowMs === "number" ? nowMs : Date.now());
    await this.ctx.blockConcurrencyWhile(async () => {
      refundSql(sqlOf(this.ctx), "asks", now);
    });
  }

  async refundSearch(nowMs?: number): Promise<void> {
    const now = new Date(typeof nowMs === "number" ? nowMs : Date.now());
    await this.ctx.blockConcurrencyWhile(async () => {
      refundSql(sqlOf(this.ctx), "searches", now);
    });
  }

  async rememberToken(hash: string, nowMs?: number): Promise<boolean> {
    const now = typeof nowMs === "number" ? nowMs : Date.now();
    return this.ctx.blockConcurrencyWhile(async () => rememberSql(sqlOf(this.ctx), hash, now));
  }

  async takeToken(hash: string, nowMs?: number): Promise<TokenDecision> {
    const now = typeof nowMs === "number" ? nowMs : Date.now();
    return this.ctx.blockConcurrencyWhile(async () => takeSql(sqlOf(this.ctx), hash, now));
  }
}
