/** Abandoned tabs would otherwise keep the Workspace DO awake via the Cap'n Web socket + ping. */
export const SESSION_IDLE_MS = 20 * 60 * 1000;

export type IdleReason = "idle";

/** User RPC after the idle window: wake a quiet workspace, or reap leftover subscribers. */
export type UserRpcDecision = "touch" | "wake" | "reap";

/** Keepalive ping never resets idle. */
export type PingDecision = "ok" | "reap" | "reject";

export function idleReason(now: number, lastUserActivity: number): IdleReason | null {
  if (!Number.isFinite(now) || !Number.isFinite(lastUserActivity)) return "idle";
  if (now - lastUserActivity >= SESSION_IDLE_MS) return "idle";
  return null;
}

export function nextIdleAlarmAt(now: number, lastUserActivity: number): number {
  return Math.max(now + 1_000, lastUserActivity + SESSION_IDLE_MS);
}

export function idleErrorMessage(_reason: IdleReason = "idle"): string {
  return "This workspace paused after 20 minutes idle to limit Durable Object billing. Refresh to continue.";
}

/**
 * Any user RPC (listBlueprints, subscribe, gadget UI, chat, …) resets idle.
 * After a reap, listenerCount is 0 and the next RPC starts a fresh window so Refresh works.
 * Ping must not use this path.
 */
export function decideUserRpc(now: number, lastActivity: number, listenerCount: number): UserRpcDecision {
  const reason = idleReason(now, lastActivity);
  if (!reason) return "touch";
  return listenerCount === 0 ? "wake" : "reap";
}

export function decidePing(now: number, lastActivity: number, listenerCount: number): PingDecision {
  const reason = idleReason(now, lastActivity);
  if (!reason) return "ok";
  return listenerCount > 0 ? "reap" : "reject";
}
