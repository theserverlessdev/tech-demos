// Smoke: bun run scripts/smoke.ts [baseUrl]
import type { Health, Orb, Player, RoomInfo, RoundState, ServerEvent } from "../src/shared/types";

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

function waitFor(ws: WebSocket, pred: (event: ServerEvent) => boolean, ms = 10_000): Promise<ServerEvent> {
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

function stepToward(from: { x: number; z: number }, to: { x: number; z: number }, max = 2.4) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const d = Math.hypot(dx, dz);
  if (d <= max) return { x: to.x, z: to.z };
  return { x: from.x + (dx / d) * max, z: from.z + (dz / d) * max };
}

console.log(`Target: ${base}`);

const health = await call<Health>("/health");
check("health is ok", health.status === 200 && health.data?.ok === true && health.data.demo === "goodvibes", health.data);
check("health advertises hibernation", health.data?.hibernation === true, health.data);
check("health advertises ember-rush", health.data?.game === "ember-rush", health.data);

const created = await call<{ room: RoomInfo }>("/rooms", { method: "POST", body: { name: "Smoke Arena" } });
check("POST /api/rooms creates a slug", created.status === 201 && created.data?.room.id === "smoke-arena", created.data);
const room = created.data?.room.id ?? "smoke-arena";

const a = openSocket(room, "Smoke A", "smoke-a");
const helloA = await waitFor(a, (e) => e.type === "hello").catch((err) => err as Error);
check("first socket receives hello", helloA instanceof Error === false && (helloA as ServerEvent).type === "hello", helloA);
const youA = helloA instanceof Error ? null : helloA.type === "hello" ? helloA.you : null;
const round0 = helloA instanceof Error || helloA.type !== "hello" ? null : helloA.round;
check("hello includes a local player", Boolean(youA?.id && youA.name), youA);
check("hello round is waiting", round0?.phase === "waiting", round0);

const b = openSocket(room, "Smoke B", "smoke-b");
const helloB = await waitFor(b, (e) => e.type === "hello").catch((err) => err as Error);
check("second socket receives hello", helloB instanceof Error === false && (helloB as ServerEvent).type === "hello", helloB);
check(
  "second hello lists both players",
  helloB instanceof Error === false && helloB.type === "hello" && helloB.players.length >= 2,
  helloB instanceof Error ? helloB : helloB.type === "hello" ? helloB.players.map((p: Player) => p.name) : helloB,
);

a.send(JSON.stringify({ type: "start" }));
const countdown = await waitFor(b, (e) => e.type === "round" && e.round.phase === "countdown").catch((err) => err as Error);
check("start announces countdown over WS", countdown instanceof Error === false, countdown);

const playing = await waitFor(b, (e) => e.type === "round" && e.round.phase === "playing", 12_000).catch((err) => err as Error);
check("alarm flips the room into playing", playing instanceof Error === false, playing);
const roundPlay: RoundState | null = playing instanceof Error || playing.type !== "round" ? null : playing.round;
check("playing round has orbs", (roundPlay?.orbs.length ?? 0) >= 3, roundPlay?.orbs.length);
const playersPlay = playing instanceof Error || playing.type !== "round" ? [] : playing.players;
const poseA = playersPlay.find((p) => p.id === youA?.id) ?? youA;
const orb: Orb | undefined = roundPlay?.orbs[0];

const collected = await new Promise<boolean>((resolve) => {
  if (!poseA || !orb) {
    resolve(false);
    return;
  }
  const timer = setTimeout(() => resolve(false), 8_000);
  b.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    try {
      const event = JSON.parse(ev.data) as ServerEvent;
      if (event.type === "collect" && event.playerId === youA?.id) {
        clearTimeout(timer);
        resolve(event.score >= 1);
      }
    } catch {
      /* ignore */
    }
  });
  let pos = { x: poseA.x, z: poseA.z };
  const tick = () => {
    pos = stepToward(pos, orb);
    a.send(JSON.stringify({ type: "move", x: pos.x, z: pos.z }));
    if (Math.hypot(pos.x - orb.x, pos.z - orb.z) > 0.2) setTimeout(tick, 45);
  };
  tick();
});
check("A collecting an orb is scored on B", collected);

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
