/** One network may mint this many new Dynamic Worker IDs each UTC day. */
export const LOADER_IP_SHARE = 0.15;

export function loaderIpCap(globalCap: number): number {
  return Math.max(1, Math.floor(globalCap * LOADER_IP_SHARE));
}

export function loaderClaimDecision(input: {
  alreadyClaimed: boolean;
  globalCount: number;
  ipCount: number;
  globalCap: number;
  ipCap: number;
}): { ok: boolean; count: number; cap: number; reason?: "global" | "ip" } {
  if (input.alreadyClaimed) return { ok: true, count: input.globalCount, cap: input.globalCap };
  if (input.globalCount >= input.globalCap) {
    return { ok: false, count: input.globalCount, cap: input.globalCap, reason: "global" };
  }
  if (input.ipCount >= input.ipCap) {
    return { ok: false, count: input.globalCount, cap: input.globalCap, reason: "ip" };
  }
  return { ok: true, count: input.globalCount + 1, cap: input.globalCap };
}
