/** Cap'n Web sessions must be disposed or each failed connect leaks a WebSocket. */
export type DisposableRpcRoot = { [Symbol.dispose]?: () => void };

export const RECONNECT_INITIAL_MS = 800;
export const RECONNECT_MAX_MS = 10_000;
export const RECONNECT_FACTOR = 1.8;
/** Transient errors retry with capped delay. Idle errors stop immediately. */
export const RECONNECT_MAX_ATTEMPTS = 8;

export function errMsg(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error:\s*/, "");
}

export function isIdleError(err: unknown): boolean {
  return /paused after .* idle/i.test(errMsg(err));
}

export function nextReconnectDelay(current: number): number {
  return Math.min(Math.max(current, 1) * RECONNECT_FACTOR, RECONNECT_MAX_MS);
}

export type ConnectFailureAction = "pause-idle" | "retry" | "give-up";

export function connectFailureAction(err: unknown, attempts: number): ConnectFailureAction {
  if (isIdleError(err)) return "pause-idle";
  if (attempts >= RECONNECT_MAX_ATTEMPTS) return "give-up";
  return "retry";
}

export function disposeRpcRoot(root: DisposableRpcRoot | null | undefined): void {
  if (!root) return;
  try {
    root[Symbol.dispose]?.();
  } catch {
    /* a broken socket still must not keep the handle */
  }
}
