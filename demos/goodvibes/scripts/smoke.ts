// Smoke: bun run scripts/smoke.ts [baseUrl]
import type { Health, Player, RoomInfo, ServerEvent } from "../src/shared/types";

const base = (process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");

let failures = 0;
function check(label: string, ok: unknown, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${base}/api${path}`, { method: init.method ?? "GET", headers, body });
  const text = await res.text();
  let data: T | null = null;
  try {
    data = JSON.parse(text) as T;
  } catch {
    data = null;
  }
  return { status: res.status, data, text };
}

function openSocket(room: string, name: string, id: string): WebSocket {
  const url = base.replace(/^http/, "ws") + `/ws/${encodeURIComponent(room)}?name=${encodeURIComponent(name)}&id=${encodeURIComponent(id)}`;
  return new WebSocket(url);
}

function waitFor(ws: WebSocket, pred: (event: ServerEvent) => boolean, ms = 8_000): Promise<ServerEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    const onMsg = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      try {
        const event = JSON.parse(ev.data) as ServerEvent;
        if (pred(event)) {
          clearTimeout(timer);
          ws.removeEventListener("message", onMsg);
          resolve(event);
        }
      } catch {
        /* ignore */
      }
    };
    ws.addEventListener("message", onMsg);
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("socket error"));
    });
  });
}

console.log(`Target: ${base}`);

const health = await call<Health>("/health");
check("health is ok", health.status === 200 && health.data?.ok === true && health.data.demo === "goodvibes", health.data);
check("health advertises hibernation", health.data?.hibernation === true, health.data);

const created = await call<{ room: RoomInfo }>("/rooms", { method: "POST", body: { name: "Smoke Floor" } });
check("POST /api/rooms creates a slug", created.status === 201 && created.data?.room.id === "smoke-floor", created.data);
const room = created.data?.room.id ?? "smoke-floor";

const a = openSocket(room, "Smoke A", "smoke-a");
const helloA = await waitFor(a, (e) => e.type === "hello").catch((err) => err as Error);
check("first socket receives hello", helloA instanceof Error === false && (helloA as ServerEvent).type === "hello", helloA);
const youA = helloA instanceof Error ? null : helloA.type === "hello" ? helloA.you : null;
check("hello includes a local player", Boolean(youA?.id && youA.name), youA);

const b = openSocket(room, "Smoke B", "smoke-b");
const helloB = await waitFor(b, (e) => e.type === "hello").catch((err) => err as Error);
check("second socket receives hello", helloB instanceof Error === false && (helloB as ServerEvent).type === "hello", helloB);

const seenJoin = helloB instanceof Error ? false : helloB.type === "hello" && helloB.players.length >= 2;
check("second hello lists both players", seenJoin, helloB instanceof Error ? helloB : helloB.type === "hello" ? helloB.players.map((p: Player) => p.name) : helloB);

const moved = await new Promise<boolean>((resolve) => {
  const timer = setTimeout(() => resolve(false), 8_000);
  b.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    try {
      const event = JSON.parse(ev.data) as ServerEvent;
      if (event.type === "move" && event.id === youA?.id) {
        clearTimeout(timer);
        resolve(Math.abs(event.x - 1.25) < 0.05 && Math.abs(event.z - 0.5) < 0.05);
      }
    } catch {
      /* ignore */
    }
  });
  a.send(JSON.stringify({ type: "move", x: 1.25, z: 0.5 }));
});
check("move from A is visible on B", moved);

a.close();
b.close();

let limited = false;
for (let i = 0; i < 16; i++) {
  const res = await call("/rooms", { method: "POST", body: { name: `burst-${i}` } });
  if (res.status === 429) {
    limited = true;
    break;
  }
}
check("room create is rate-limited (429)", limited);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
