/** Abandoned tabs would otherwise keep the Workspace DO awake via the Cap'n Web socket + ping. */
export const SESSION_IDLE_MS = 20 * 60 * 1000;

export type IdleReason = "idle";

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
