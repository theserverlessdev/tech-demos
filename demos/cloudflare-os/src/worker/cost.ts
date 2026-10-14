/** Published Workers AI prices for `@cf/zai-org/glm-5.3-flash`, USD per token.
 *  Confirmed against https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/
 *  ($0.15 / M input, $0.50 / M output). Not the full GLM-5.3 $1.40 / $4.40 rates. */
export const PRICE_IN = 0.15 / 1_000_000;
export const PRICE_OUT = 0.5 / 1_000_000;

export type Usage = { prompt_tokens?: unknown; completion_tokens?: unknown };

function isTokenCount(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/** True only when the model reported at least one parseable token count. */
export function hasReportedUsage(usage: Usage | undefined): boolean {
  if (!usage || typeof usage !== "object") return false;
  return isTokenCount(usage.prompt_tokens) || isTokenCount(usage.completion_tokens);
}

/**
 * Cost of one model response. When `usage` is missing or unparseable, charge
 * `reservedUsd` (worst-case hold) instead of $0 so the daily budget cannot fail open.
 */
export function usageCost(
  usage: Usage | undefined,
  reservedUsd = 0,
): { usd: number; tokensIn: number; tokensOut: number; estimated: boolean } {
  if (!usage || !hasReportedUsage(usage)) {
    return { usd: Math.max(0, reservedUsd), tokensIn: 0, tokensOut: 0, estimated: true };
  }
  const tokensIn = isTokenCount(usage.prompt_tokens) ? usage.prompt_tokens : 0;
  const tokensOut = isTokenCount(usage.completion_tokens) ? usage.completion_tokens : 0;
  return { usd: tokensIn * PRICE_IN + tokensOut * PRICE_OUT, tokensIn, tokensOut, estimated: false };
}

/** Replace a reservation with the real (or fail-closed) cost. */
export function applySettle(spent: number, reserved: number, actual: number): number {
  return Math.max(0, spent - Math.max(0, reserved) + Math.max(0, actual));
}

/** Worst-case cost of one agent step: 9,000 output tokens and 30,000 input tokens. */
export const AGENT_STEP_RESERVE_USD = 9000 * PRICE_OUT + 30_000 * PRICE_IN;
/** Worst-case cost of one gadget completion: 800 output tokens and 3,000 input tokens. */
export const COMPLETION_RESERVE_USD = 800 * PRICE_OUT + 3000 * PRICE_IN;
