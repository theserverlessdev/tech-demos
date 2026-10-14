import { expect, test } from "bun:test";
import {
  ConnectGuard,
  connectFailureAction,
  disposeRpcRoot,
  isIdleError,
  isUserInitiatedActivity,
  nextReconnectDelay,
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_MS,
  USER_ACTIVITY_WINDOW_MS,
} from "../src/client/reconnect";
import {
  decidePing,
  decideUserRpc,
  idleErrorMessage,
  SESSION_IDLE_MS,
} from "../src/worker/idle";

/**
 * In-memory stand-in for Workspace + WorkspaceClient idle rules.
 * Same call order as the shell: openSession → listBlueprints → subscribe.
 */
class IdleWorkspace {
  lastActivity: number;
  listeners = 0;
  reaped = false;

  constructor(now: number) {
    this.lastActivity = now;
  }

  openSession() {
    return new IdleClient(this);
  }

  beginSession(now: number) {
    const decision = decideUserRpc(now, this.lastActivity, this.listeners);
    if (decision === "reap") {
      this.#reap();
      throw new Error(idleErrorMessage("idle"));
    }
    this.lastActivity = now;
  }

  ping(now: number) {
    const decision = decidePing(now, this.lastActivity, this.listeners);
    if (decision === "ok") return now;
    if (decision === "reap") this.#reap();
    throw new Error(idleErrorMessage("idle"));
  }

  touchActivity(now: number) {
    this.lastActivity = now;
  }

  #reap() {
    this.listeners = 0;
    this.reaped = true;
  }
}

class IdleClient {
  constructor(private readonly ws: IdleWorkspace) {}

  listBlueprints(now: number) {
    this.ws.beginSession(now);
    return ["slides"];
  }

  subscribe(now: number) {
    this.ws.beginSession(now);
    this.ws.listeners += 1;
  }

  ping(now: number) {
    return this.ws.ping(now);
  }

  /** User-initiated gadget call (pointer/key within the activity window). */
  paint(now: number, lastUserInput: number) {
    this.ws.beginSession(now);
    if (isUserInitiatedActivity(now, lastUserInput)) this.ws.touchActivity(now);
  }

  /** setInterval / dashboard poll. Must not reset idle. */
  timerTick(now: number, lastUserInput: number) {
    if (isUserInitiatedActivity(now, lastUserInput)) this.ws.touchActivity(now);
  }
}

test("after idle reap, listBlueprints then subscribe succeeds (Refresh path)", () => {
  const t0 = 1_000_000;
  const ws = new IdleWorkspace(t0);
  const first = ws.openSession();
  first.subscribe(t0);
  expect(ws.listeners).toBe(1);

  const idleAt = t0 + SESSION_IDLE_MS;
  expect(decideUserRpc(idleAt, ws.lastActivity, ws.listeners)).toBe("reap");
  expect(() => first.listBlueprints(idleAt)).toThrow(/paused after .* idle/);
  expect(ws.reaped).toBe(true);
  expect(ws.listeners).toBe(0);

  const refreshAt = idleAt + 5_000;
  const next = ws.openSession();
  expect(next.listBlueprints(refreshAt)).toEqual(["slides"]);
  next.subscribe(refreshAt);
  expect(ws.listeners).toBe(1);
  expect(ws.lastActivity).toBe(refreshAt);
  expect(() => next.ping(refreshAt + 20_000)).not.toThrow();
});

test("ping after reap still fails and does not reset idle", () => {
  const t0 = 2_000_000;
  const ws = new IdleWorkspace(t0);
  const client = ws.openSession();
  client.subscribe(t0);
  expect(() => client.ping(t0 + SESSION_IDLE_MS)).toThrow(/paused after .* idle/);
  expect(ws.lastActivity).toBe(t0);
  expect(ws.listeners).toBe(0);

  expect(() => client.ping(t0 + SESSION_IDLE_MS + 1_000)).toThrow(/paused after .* idle/);
  expect(ws.lastActivity).toBe(t0);
});

test("user-initiated gadget use counts as activity; timer ticks do not", () => {
  const t0 = 3_000_000;
  const ws = new IdleWorkspace(t0);
  const client = ws.openSession();
  client.subscribe(t0);
  client.paint(t0 + SESSION_IDLE_MS - 1_000, t0 + SESSION_IDLE_MS - 1_000);
  expect(ws.lastActivity).toBe(t0 + SESSION_IDLE_MS - 1_000);
  expect(decideUserRpc(t0 + SESSION_IDLE_MS, ws.lastActivity, ws.listeners)).toBe("touch");

  const later = t0 + SESSION_IDLE_MS + 10_000;
  client.timerTick(later, t0 + SESSION_IDLE_MS - 1_000);
  expect(ws.lastActivity).toBe(t0 + SESSION_IDLE_MS - 1_000);
  expect(isUserInitiatedActivity(later, t0 + SESSION_IDLE_MS - 1_000)).toBe(false);

  const poll = t0 + 4_000;
  for (let i = 1; i <= 20; i++) client.timerTick(poll + i * 3_000, t0);
  expect(ws.lastActivity).toBe(t0);
  expect(decideUserRpc(t0 + SESSION_IDLE_MS, ws.lastActivity, ws.listeners)).toBe("reap");
});

test("isUserInitiatedActivity is a few-minute window after real input", () => {
  const t0 = 8_000_000;
  expect(isUserInitiatedActivity(t0, 0)).toBe(false);
  expect(isUserInitiatedActivity(t0 + 1_000, t0)).toBe(true);
  expect(isUserInitiatedActivity(t0 + USER_ACTIVITY_WINDOW_MS - 1, t0)).toBe(true);
  expect(isUserInitiatedActivity(t0 + USER_ACTIVITY_WINDOW_MS, t0)).toBe(false);
});

test("decideUserRpc wakes only when nobody is subscribed", () => {
  const t0 = 4_000_000;
  const idleAt = t0 + SESSION_IDLE_MS;
  expect(decideUserRpc(t0 + 1_000, t0, 1)).toBe("touch");
  expect(decideUserRpc(idleAt, t0, 0)).toBe("wake");
  expect(decideUserRpc(idleAt, t0, 2)).toBe("reap");
  expect(decidePing(idleAt, t0, 0)).toBe("reject");
  expect(decidePing(idleAt, t0, 1)).toBe("reap");
  expect(decidePing(t0 + 1_000, t0, 1)).toBe("ok");
});

test("ConnectGuard counts each failure once when catch and onRpcBroken both fire", () => {
  const idle = new Error(idleErrorMessage());
  expect(isIdleError(idle)).toBe(true);
  expect(connectFailureAction(idle, 1)).toBe("pause-idle");
  expect(connectFailureAction(new Error("socket closed"), 1)).toBe("retry");
  expect(connectFailureAction(new Error("socket closed"), RECONNECT_MAX_ATTEMPTS)).toBe("give-up");

  const guard = new ConnectGuard();
  for (let i = 0; i < 4; i++) {
    guard.beginAttempt();
    expect(guard.fail(new Error("socket closed"), "rpc-broken")).toBeNull();
    expect(guard.fail(new Error("socket closed"), "catch")).toBe("retry");
    expect(guard.fail(new Error("socket closed"), "rpc-broken")).toBeNull();
    expect(guard.attempts).toBe(i + 1);
    guard.consumeDelay();
  }
  expect(guard.attempts).toBe(4);
  expect(guard.delay).toBeLessThanOrEqual(RECONNECT_MAX_MS);

  guard.beginAttempt();
  expect(guard.fail(idle, "catch")).toBe("pause-idle");
  expect(guard.allowReconnect).toBe(false);

  const giveUp = new ConnectGuard();
  let last: ReturnType<ConnectGuard["fail"]> = "retry";
  for (let i = 0; i < RECONNECT_MAX_ATTEMPTS; i++) {
    giveUp.beginAttempt();
    last = giveUp.fail(new Error("offline"), "catch");
  }
  expect(last).toBe("give-up");
  expect(giveUp.attempts).toBe(RECONNECT_MAX_ATTEMPTS);
  expect(giveUp.allowReconnect).toBe(false);
  giveUp.resume();
  expect(giveUp.allowReconnect).toBe(true);
  expect(giveUp.attempts).toBe(0);
  expect(giveUp.delay).toBe(RECONNECT_INITIAL_MS);

  let delay = RECONNECT_INITIAL_MS;
  for (let i = 0; i < 12; i++) delay = nextReconnectDelay(delay);
  expect(delay).toBe(RECONNECT_MAX_MS);

  let disposed = 0;
  const first = { [Symbol.dispose]: () => disposed++ };
  const second = { [Symbol.dispose]: () => disposed++ };
  disposeRpcRoot(first);
  disposeRpcRoot(second);
  disposeRpcRoot(second);
  expect(disposed).toBe(3);
});

test("live socket break is recorded on rpc-broken, not again in catch", () => {
  const guard = new ConnectGuard();
  guard.beginAttempt();
  guard.markLive();
  expect(guard.fail(new Error("socket closed"), "rpc-broken")).toBe("retry");
  expect(guard.fail(new Error("socket closed"), "catch")).toBeNull();
  expect(guard.attempts).toBe(1);
});

test("workspace user RPCs go through beginSession; gadget proxy does not auto-touch", async () => {
  const workspace = await Bun.file(new URL("../src/worker/workspace.ts", import.meta.url)).text();
  expect(workspace).toContain("this.#ws.beginSession()");
  expect(workspace).toMatch(/#live\(\) \{\s*this\.#ws\.beginSession\(\);/);
  expect(workspace).toContain("decideUserRpc");
  expect(workspace).toContain("noteActivity()");
  const proxyIdx = workspace.indexOf("connectToGadget(id: string, viewer: Viewer)");
  const callIdx = workspace.indexOf("async #callGadget");
  expect(proxyIdx).toBeGreaterThan(0);
  expect(workspace.slice(proxyIdx, proxyIdx + 900)).not.toContain("self.touchActivity()");
  expect(workspace.slice(callIdx, callIdx + 160)).not.toContain("this.touchActivity()");
});

test("shell counts reconnect once, shows tap-to-reconnect, and only notes user gadget activity", async () => {
  const shell = await Bun.file(new URL("../src/client/shell.ts", import.meta.url)).text();
  expect(shell).toContain("disposeRpcRoot(previous)");
  expect(shell).toContain("applyConnectFailure");
  expect(shell).toContain('source: "catch" | "rpc-broken"');
  expect(shell).toContain("Paused · tap to reconnect");
  expect(shell).toContain("resumeFromPause");
  expect(shell).toContain("noteUserGadgetActivity");
  expect(shell).toContain("isUserInitiatedActivity");
  expect(shell).not.toContain("reconnectAttempts + 1");
});
