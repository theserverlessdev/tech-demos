import { LIMITS } from "../shared/limits";
import { HttpError } from "./errors";

type Slot = { total: number; perIp: Map<string, number> };

const state: Slot = { total: 0, perIp: new Map() };

export function currentConcurrency(): { total: number; perIp: Record<string, number> } {
  return { total: state.total, perIp: Object.fromEntries(state.perIp) };
}

export function acquireStream(ip: string): void {
  const held = state.perIp.get(ip) ?? 0;
  if (state.total >= LIMITS.concurrentGlobal || held >= LIMITS.concurrentPerIp) {
    throw new HttpError(429, "busy", "Too many live streams. Wait for one to finish.");
  }
  state.total += 1;
  state.perIp.set(ip, held + 1);
}

export function releaseStream(ip: string): void {
  state.total = Math.max(0, state.total - 1);
  const held = (state.perIp.get(ip) ?? 1) - 1;
  if (held <= 0) state.perIp.delete(ip);
  else state.perIp.set(ip, held);
}

export async function withStream<T>(ip: string, work: () => Promise<T>): Promise<T> {
  acquireStream(ip);
  try {
    return await work();
  } finally {
    releaseStream(ip);
  }
}

/** Test helper. */
export function resetConcurrency(): void {
  state.total = 0;
  state.perIp.clear();
}
