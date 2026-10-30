import { DurableObject } from "cloudflare:workers";
import { DAILY_CAP } from "../shared/protocol";
import {
  claimSql,
  ensureCapSchema,
  forgetRoomSql,
  rememberRoomSql,
  refundSql,
  roomKnownSql,
  type CapSql,
  type ClaimResult,
} from "../shared/cap";
import type { Env } from "./env";

function sqlOf(ctx: DurableObjectState): CapSql {
  return ctx.storage.sql;
}

/** One global counter and the set of room ids that are still inside their 10 minutes. */
export class CreateCap extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ensureCapSchema(sqlOf(ctx));
    });
  }

  async claim(nowMs?: number): Promise<ClaimResult> {
    const now = new Date(typeof nowMs === "number" ? nowMs : Date.now());
    return this.ctx.blockConcurrencyWhile(async () => claimSql(sqlOf(this.ctx), now, DAILY_CAP));
  }

  async refund(nowMs?: number): Promise<void> {
    const now = new Date(typeof nowMs === "number" ? nowMs : Date.now());
    await this.ctx.blockConcurrencyWhile(async () => {
      refundSql(sqlOf(this.ctx), now);
    });
  }

  async note(id: string, exp: number, nowMs?: number): Promise<boolean> {
    const now = typeof nowMs === "number" ? nowMs : Date.now();
    return this.ctx.blockConcurrencyWhile(async () => rememberRoomSql(sqlOf(this.ctx), id, exp, now));
  }

  async forget(id: string): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      forgetRoomSql(sqlOf(this.ctx), id);
    });
  }

  async known(id: string, nowMs?: number): Promise<boolean> {
    const now = typeof nowMs === "number" ? nowMs : Date.now();
    return this.ctx.blockConcurrencyWhile(async () => roomKnownSql(sqlOf(this.ctx), id, now));
  }
}
