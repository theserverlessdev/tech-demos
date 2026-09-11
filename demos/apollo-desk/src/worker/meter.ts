import { DurableObject } from "cloudflare:workers";

/** Published Workers AI prices in USD. */
export const PRICES = {
  llmIn: 0.15 / 1_000_000, // glm-5.3-flash, per input token
  llmOut: 0.5 / 1_000_000, // glm-5.3-flash, per output token
  embed: 0.02 / 1_000_000, // bge-small-en-v1.5, per token
  sttMinute: 0.0005, // whisper-large-v3-turbo, per audio minute
  ttsMinute: 0.0002, // melotts, per audio minute
};

export type Usage = { prompt_tokens?: number; completion_tokens?: number };

export function llmCost(usage: Usage | undefined) {
  const tokensIn = usage?.prompt_tokens ?? 0;
  const tokensOut = usage?.completion_tokens ?? 0;
  return { usd: tokensIn * PRICES.llmIn + tokensOut * PRICES.llmOut, tokensIn, tokensOut };
}

/** Worst case for one model round: 12,000 input tokens and 700 output tokens. */
export const LLM_ROUND_RESERVE_USD = 12_000 * PRICES.llmIn + 700 * PRICES.llmOut;

/**
 * One global instance. It holds the daily Workers AI budget for every desk, so that a busy day
 * cannot turn into a surprise bill.
 */
export class Meter extends DurableObject<Env> {
  #key() {
    return `spent:${new Date().toISOString().slice(0, 10)}`;
  }

  #budget() {
    const n = Number(this.env.AI_DAILY_BUDGET_USD);
    return Number.isFinite(n) && n > 0 ? n : 0.1;
  }

  status(): { spent: number; budget: number; ok: boolean } {
    const spent = this.ctx.storage.kv.get<number>(this.#key()) ?? 0;
    const budget = this.#budget();
    return { spent, budget, ok: spent < budget };
  }

  /** Check and hold spend in one step, so concurrent callers cannot all pass the check. */
  reserve(usd: number): { ok: boolean; spent: number; budget: number } {
    const key = this.#key();
    const spent = this.ctx.storage.kv.get<number>(key) ?? 0;
    const budget = this.#budget();
    const add = Math.max(0, usd);
    if (spent + add > budget) return { ok: false, spent, budget };
    this.ctx.storage.kv.put(key, spent + add);
    return { ok: true, spent: spent + add, budget };
  }

  /** Replace a reservation with the real cost. */
  settle(reserved: number, actual: number) {
    const key = this.#key();
    const spent = this.ctx.storage.kv.get<number>(key) ?? 0;
    this.ctx.storage.kv.put(key, Math.max(0, spent - Math.max(0, reserved) + Math.max(0, actual)));
  }
}

export function meter(env: Env): DurableObjectStub<Meter> {
  return (env.METER as unknown as DurableObjectNamespace<Meter>).getByName("global");
}

export class BudgetError extends Error {
  constructor(budget: number) {
    super(`The demo reached its daily AI budget ($${budget.toFixed(2)}). Memory, lists, and timers still show. Try a new turn tomorrow.`);
  }
}

/** Reserve the worst case, run the call, then settle to the real cost. */
export async function metered<T>(env: Env, reserveUsd: number, run: () => Promise<T>, cost: (out: T) => number): Promise<T> {
  const m = meter(env);
  const r = await m.reserve(reserveUsd);
  if (!r.ok) throw new BudgetError(r.budget);
  let out: T;
  try {
    out = await run();
  } catch (err) {
    await m.settle(reserveUsd, 0);
    throw err;
  }
  await m.settle(reserveUsd, cost(out));
  return out;
}
