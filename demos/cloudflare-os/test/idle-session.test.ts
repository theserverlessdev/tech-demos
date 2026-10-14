import { expect, test } from "bun:test";
import {
  connectFailureAction,
  disposeRpcRoot,
  isIdleError,
  nextReconnectDelay,
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_MS,
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

  paint(now: number) {
    this.ws.beginSession(now);
    this.ws.touchActivity(now);
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

test("gadget use counts as activity and delays the reap", () => {
  const t0 = 3_000_000;
  const ws = new IdleWorkspace(t0);
  const client = ws.openSession();
  client.subscribe(t0);
  client.paint(t0 + SESSION_IDLE_MS - 1_000);
  expect(ws.lastActivity).toBe(t0 + SESSION_IDLE_MS - 1_000);
  expect(decideUserRpc(t0 + SESSION_IDLE_MS, ws.lastActivity, ws.listeners)).toBe("touch");
  expect(() => client.paint(t0 + SESSION_IDLE_MS + 10_000)).not.toThrow();
  expect(ws.lastActivity).toBe(t0 + SESSION_IDLE_MS + 10_000);
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

test("connect failure pauses on idle, bounds backoff, and closes old sockets", () => {
  const idle = new Error(idleErrorMessage());
  expect(isIdleError(idle)).toBe(true);
  expect(connectFailureAction(idle, 1)).toBe("pause-idle");
  expect(connectFailureAction(new Error("socket closed"), 1)).toBe("retry");
  expect(connectFailureAction(new Error("socket closed"), RECONNECT_MAX_ATTEMPTS)).toBe("give-up");

  let delay = RECONNECT_INITIAL_MS;
  for (let i = 0; i < 12; i++) delay = nextReconnectDelay(delay);
  expect(delay).toBe(RECONNECT_MAX_MS);
  expect(delay).toBeLessThanOrEqual(10_000);

  let disposed = 0;
  const first = { [Symbol.dispose]: () => disposed++ };
  const second = { [Symbol.dispose]: () => disposed++ };
  disposeRpcRoot(first);
  disposeRpcRoot(second);
  disposeRpcRoot(second);
  expect(disposed).toBe(3);
});

test("workspace user RPCs go through beginSession and gadget calls touch activity", async () => {
  const workspace = await Bun.file(new URL("../src/worker/workspace.ts", import.meta.url)).text();
  expect(workspace).toContain("this.#ws.beginSession()");
  expect(workspace).toMatch(/#live\(\) \{\s*this\.#ws\.beginSession\(\);/);
  expect(workspace).toContain("decideUserRpc");
  const proxyIdx = workspace.indexOf("connectToGadget(id: string, viewer: Viewer)");
  const callIdx = workspace.indexOf("async #callGadget");
  expect(proxyIdx).toBeGreaterThan(0);
  expect(workspace.slice(proxyIdx, proxyIdx + 900)).toContain("self.touchActivity()");
  expect(workspace.slice(callIdx, callIdx + 200)).toContain("this.touchActivity()");
});

test("shell closes the previous socket and pauses on idle instead of retrying", async () => {
  const shell = await Bun.file(new URL("../src/client/shell.ts", import.meta.url)).text();
  expect(shell).toContain("disposeRpcRoot(previous)");
  expect(shell).toContain("disposeRpcRoot(root)");
  expect(shell).toContain("connectFailureAction");
  expect(shell).toContain('action === "pause-idle"');
  expect(shell).toContain("nextReconnectDelay");
  expect(shell).not.toMatch(/catch \(err\) \{\s*console\.error\("connect failed", err\);\s*if \(rootStub === root\) \{\s*setConn\("offline"\);\s*scheduleReconnect\(\);/);
});
