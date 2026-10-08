import type { GateFailure, GateOk } from "./turnstile";

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || "local";
}

export async function enforceLimit(limiter: RateLimit, request: Request): Promise<GateOk | GateFailure> {
  try {
    const { success } = await limiter.limit({ key: clientIp(request) });
    if (!success) {
      return { ok: false, status: 429, code: "rate_limited", message: "Too many requests from this network. Wait a minute." };
    }
    return { ok: true };
  } catch (err) {
    console.error(JSON.stringify({ event: "rate_limit_failed", error: err instanceof Error ? err.name : "error" }));
    return { ok: false, status: 503, code: "rate_limit_unavailable", message: "Rate limiting is unavailable. Try again shortly." };
  }
}
