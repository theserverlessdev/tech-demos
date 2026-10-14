/** Cap'n Web sessions must be disposed or each failed connect leaks a WebSocket. */
export type DisposableRpcRoot = { [Symbol.dispose]?: () => void };

export const RECONNECT_INITIAL_MS = 800;
export const RECONNECT_MAX_MS = 10_000;
export const RECONNECT_FACTOR = 1.8;
/** Transient errors retry with capped delay. Idle errors stop immediately. */
export const RECONNECT_MAX_ATTEMPTS = 8;

/** Gadget RPCs count as activity only if a person used the shell/frame recently. */
export const USER_ACTIVITY_WINDOW_MS = 3 * 60 * 1000;

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

export function isUserInitiatedActivity(now: number, lastUserInput: number, windowMs = USER_ACTIVITY_WINDOW_MS): boolean {
  return Number.isFinite(lastUserInput) && lastUserInput > 0 && now - lastUserInput >= 0 && now - lastUserInput < windowMs;
}

export function disposeRpcRoot(root: DisposableRpcRoot | null | undefined): void {
  if (!root) return;
  try {
    root[Symbol.dispose]?.();
  } catch {
    /* a broken socket still must not keep the handle */
  }
}

/**
 * One failure = one increment. capnweb fires onRpcBroken from abort() during dispose,
 * so the handshake catch and the broken hook must share this guard.
 */
export class ConnectGuard {
  attempts = 0;
  delay = RECONNECT_INITIAL_MS;
  allowReconnect = true;
  handshakeOpen = false;
  #failureHandled = false;

  beginAttempt() {
    this.#failureHandled = false;
    this.handshakeOpen = false;
  }

  markLive() {
    this.attempts = 0;
    this.delay = RECONNECT_INITIAL_MS;
    this.handshakeOpen = true;
    this.#failureHandled = false;
    this.allowReconnect = true;
  }

  /**
   * @param source `rpc-broken` during handshake is ignored — the catch will record it.
   * A later live-socket break is recorded here.
   */
  fail(err: unknown, source: "catch" | "rpc-broken"): ConnectFailureAction | null {
    if (source === "rpc-broken" && !this.handshakeOpen) return null;
    if (this.#failureHandled) return null;
    this.#failureHandled = true;
    if (isIdleError(err)) {
      this.allowReconnect = false;
      return "pause-idle";
    }
    this.attempts += 1;
    if (this.attempts >= RECONNECT_MAX_ATTEMPTS) {
      this.allowReconnect = false;
      return "give-up";
    }
    return "retry";
  }

  consumeDelay(): number {
    const wait = this.delay;
    this.delay = nextReconnectDelay(this.delay);
    return wait;
  }

  resume() {
    this.allowReconnect = true;
    this.attempts = 0;
    this.delay = RECONNECT_INITIAL_MS;
    this.#failureHandled = false;
    this.handshakeOpen = false;
  }
}
