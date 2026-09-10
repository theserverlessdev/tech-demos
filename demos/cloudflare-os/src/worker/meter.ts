import { DurableObject } from "cloudflare:workers";

/** Published Workers AI prices for glm-5.3-flash, in USD per token. */
export const PRICE_IN = 0.15 / 1_000_000;
export const PRICE_OUT = 0.5 / 1_000_000;

export type Usage = { prompt_tokens?: number; completion_tokens?: number };

export function usageCost(usage: Usage | undefined): { usd: number; tokensIn: number; tokensOut: number } {
  const tokensIn = usage?.prompt_tokens ?? 0;
  const tokensOut = usage?.completion_tokens ?? 0;
  return { usd: tokensIn * PRICE_IN + tokensOut * PRICE_OUT, tokensIn, tokensOut };
}

/**
 * One global instance. It holds the daily Workers AI budget for the whole demo, so that a busy day
 * cannot turn into a surprise bill.
 */
export class Meter extends DurableObject<Env> {
  #key() {
    return `spent:${new Date().toISOString().slice(0, 10)}`;
  }

  #budget() {
    const n = Number(this.env.AI_DAILY_BUDGET_USD);
    return Number.isFinite(n) && n > 0 ? n : 0.15;
  }

  status(): { spent: number; budget: number; ok: boolean } {
    const spent = (this.ctx.storage.kv.get<number>(this.#key()) ?? 0) as number;
    const budget = this.#budget();
    return { spent, budget, ok: spent < budget };
  }

  /**
   * Each unique Dynamic Worker ID costs money after the monthly allowance. Visitors can save code, so the
   * demo caps how many new IDs it loads each day.
   */
  claimLoader(id: string): { ok: boolean; count: number; cap: number } {
    const kv = this.ctx.storage.kv;
    const day = new Date().toISOString().slice(0, 10);
    const cap = Number(this.env.DYNAMIC_WORKER_DAILY_CAP) || 60;
    if (kv.get(`loader:${day}:${id}`)) return { ok: true, count: (kv.get<number>(`loaders:${day}`) ?? 0) as number, cap };
    const count = (kv.get<number>(`loaders:${day}`) ?? 0) as number;
    if (count === 0) {
      for (const [key] of kv.list({ prefix: "loader" })) {
        if (!key.startsWith(`loader:${day}:`) && key !== `loaders:${day}`) kv.delete(key);
      }
    }
    if (count >= cap) return { ok: false, count, cap };
    kv.put(`loader:${day}:${id}`, 1);
    kv.put(`loaders:${day}`, count + 1);
    return { ok: true, count: count + 1, cap };
  }

  /** Check and hold spend in one step, so concurrent callers cannot all pass the check. */
  reserve(usd: number): { ok: boolean; spent: number; budget: number } {
    const key = this.#key();
    const spent = (this.ctx.storage.kv.get<number>(key) ?? 0) as number;
    const budget = this.#budget();
    if (spent + Math.max(0, usd) > budget) return { ok: false, spent, budget };
    this.ctx.storage.kv.put(key, spent + Math.max(0, usd));
    return { ok: true, spent: spent + Math.max(0, usd), budget };
  }

  /** Replace a reservation with the real cost. */
  settle(reserved: number, actual: number) {
    const key = this.#key();
    const spent = (this.ctx.storage.kv.get<number>(key) ?? 0) as number;
    this.ctx.storage.kv.put(key, Math.max(0, spent - Math.max(0, reserved) + Math.max(0, actual)));
  }

  charge(usd: number): { spent: number; budget: number } {
    const key = this.#key();
    const spent = ((this.ctx.storage.kv.get<number>(key) ?? 0) as number) + Math.max(0, usd);
    this.ctx.storage.kv.put(key, spent);
    return { spent, budget: this.#budget() };
  }
}

export function meter(env: Env): DurableObjectStub<Meter> {
  return (env.METER as unknown as DurableObjectNamespace<Meter>).getByName("global");
}

/** Worst-case cost of one agent step: 9,000 output tokens and 30,000 input tokens. */
export const AGENT_STEP_RESERVE_USD = 9000 * PRICE_OUT + 30_000 * PRICE_IN;
/** Worst-case cost of one gadget completion: 800 output tokens and 3,000 input tokens. */
export const COMPLETION_RESERVE_USD = 800 * PRICE_OUT + 3000 * PRICE_IN;

export async function reserveBudget(env: Env, usd: number): Promise<void> {
  const r = await meter(env).reserve(usd);
  if (!r.ok) {
    throw new Error(
      `The demo reached its daily AI budget ($${r.budget.toFixed(2)}). Blueprints still work. Try the agent again tomorrow.`,
    );
  }
}

export async function assertBudget(env: Env): Promise<void> {
  const s = await meter(env).status();
  if (!s.ok) {
    throw new Error(
      `The demo reached its daily AI budget ($${s.budget.toFixed(2)}). Blueprints still work. Try the agent again tomorrow.`,
    );
  }
}
