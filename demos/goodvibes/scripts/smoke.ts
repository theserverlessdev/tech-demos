// Smoke: bun run scripts/smoke.ts [baseUrl]
import type { Health, JoinTicket, Orb, Player, PublicConfig, RoundState, ServerEvent } from "../src/shared/types";
import { formatClock, sanitizeName } from "../src/shared/types";
import { mintJoinTicket, verifyJoinTicket } from "../src/worker/ticket";
import { TEST_TURNSTILE_SECRET, TEST_TURNSTILE_SITE_KEY, assessTurnstile } from "../src/worker/turnstile";

const base = (process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const DUMMY = "XXXX.DUMMY.TOKEN.XXXX";

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

async function mint(name: string): Promise<JoinTicket> {
  const res = await call<JoinTicket>("/rooms", { method: "POST", body: { name, turnstileToken: DUMMY } });
  if (res.status !== 201 || !res.data?.ticket || !res.data.room?.id) {
    throw new Error(`mint failed ${res.status} ${res.text}`);
  }
  return res.data;
}

function openSocket(room: string, name: string, ticket: string, clientId?: string): WebSocket {
  const params = new URLSearchParams({ name, ticket });
  if (clientId) params.set("id", clientId);
  const url = `${base.replace(/^http/, "ws")}/ws/${encodeURIComponent(room)}?${params}`;
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

function stepToward(from: { x: number; z: number }, to: { x: number; z: number }, max = 0.35) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const d = Math.hypot(dx, dz);
  if (d <= max) return { x: to.x, z: to.z };
  return { x: from.x + (dx / d) * max, z: from.z + (dz / d) * max };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

check("missing secret is closed", assessTurnstile({ secret: "", siteKey: "real-site", allowTestCredentials: false }) === "closed");
check(
  "production rejects the always-pass test secret",
  assessTurnstile({ secret: TEST_TURNSTILE_SECRET, siteKey: "real-site", allowTestCredentials: false }) === "closed",
);
check(
  "local flag accepts the published test pair",
  assessTurnstile({ secret: TEST_TURNSTILE_SECRET, siteKey: TEST_TURNSTILE_SITE_KEY, allowTestCredentials: true }) === "open",
);
check("clock formats 75s as 1:15", formatClock(75) === "1:15", formatClock(75));
check("unicode name is kept", sanitizeName("राहुल") === "राहुल" && sanitizeName("李雷") === "李雷" && sanitizeName("José") === "José");

{
  const secret = "smoke-join-secret";
  const minted = await mintJoinTicket(secret, "arena");
  check("ticket verifies for its room", await verifyJoinTicket(secret, minted.ticket, "arena"));
  check("ticket rejects another room", !(await verifyJoinTicket(secret, minted.ticket, "other")));
}

console.log(`Target: ${base}`);

const health = await call<Health>("/health");
check("health is ok", health.status === 200 && health.data?.ok === true && health.data.demo === "goodvibes", health.data);
check("health advertises hibernation", health.data?.hibernation === true, health.data);
check("health advertises ember-rush", health.data?.game === "ember-rush", health.data);

const config = await call<PublicConfig>("/config");
check("config is open locally", config.status === 200 && config.data?.createOpen === true, config.data);

const missing = await call("/rooms", { method: "POST", body: {} });
check("join without a token is rejected", missing.status === 400, missing.data);

const bad = await call("/rooms", { method: "POST", body: { turnstileToken: "not-a-token" } });
check("join with a bad token is rejected", bad.status === 400, bad.data);

const created = await mint("Smoke Arena");
check("POST /api/rooms mints a ticket", created.room.id === "smoke-arena" && created.ticket.includes("."), created);
const room = created.room.id;

const noTicket = await fetch(`${base}/ws/${room}?name=Nope`, { headers: { Upgrade: "websocket" } });
check("WS without a ticket is refused", noTicket.status === 403 || noTicket.status === 426, noTicket.status);

const badUri = await fetch(`${base}/ws/%E0%A4%A`);
check("bad percent-encoding is 400", badUri.status === 400, badUri.status);

const spa = await fetch(`${base}/x/assets/app.js`);
check("unknown path is 404 not HTML", spa.status === 404, spa.status);

const ticketA = created.ticket;
const a = openSocket(room, "Smoke A", ticketA, "shared-client-id");
const helloA = await waitFor(a, (e) => e.type === "hello").catch((err) => err as Error);
check("first socket receives hello", helloA instanceof Error === false && (helloA as ServerEvent).type === "hello", helloA);
const youA = helloA instanceof Error ? null : helloA.type === "hello" ? helloA.you : null;
const round0 = helloA instanceof Error || helloA.type !== "hello" ? null : helloA.round;
check("hello includes a server-assigned id", Boolean(youA?.id && youA.id.length > 8), youA);
check("hello ignores a client id", youA?.id !== "shared-client-id", youA?.id);
check("hello round is waiting", round0?.phase === "waiting", round0);
check("hello has serverNow", helloA instanceof Error === false && helloA.type === "hello" && helloA.serverNow > 0);

const ticketB = (await mint(room)).ticket;
const b = openSocket(room, "Smoke B", ticketB, "shared-client-id");
const helloB = await waitFor(b, (e) => e.type === "hello").catch((err) => err as Error);
check("second socket receives hello", helloB instanceof Error === false && (helloB as ServerEvent).type === "hello", helloB);
const youB = helloB instanceof Error || helloB.type !== "hello" ? null : helloB.you;
check("server ids are unique", Boolean(youA?.id && youB?.id && youA.id !== youB.id), { a: youA?.id, b: youB?.id });
check(
  "second hello lists both players",
  helloB instanceof Error === false && helloB.type === "hello" && helloB.players.length >= 2,
  helloB instanceof Error ? helloB : helloB.type === "hello" ? helloB.players.map((p: Player) => p.name) : helloB,
);

check("same client id does not take over the first player", Boolean(youA?.id && youB?.id && youA.id !== youB.id && youA.id !== "shared-client-id"), {
  a: youA?.id,
  b: youB?.id,
});

a.send(JSON.stringify({ type: "start" }));
const countdown = await waitFor(b, (e) => e.type === "round" && e.round.phase === "countdown").catch((err) => err as Error);
check("start announces countdown over WS", countdown instanceof Error === false, countdown);

const playing = await waitFor(b, (e) => e.type === "round" && e.round.phase === "playing", 12_000).catch((err) => err as Error);
check("alarm flips the room into playing", playing instanceof Error === false, playing);
const roundPlay: RoundState | null = playing instanceof Error || playing.type !== "round" ? null : playing.round;
check("playing round has orbs", (roundPlay?.orbs.length ?? 0) >= 3, roundPlay?.orbs.length);
check("exactly one gold orb at start", (roundPlay?.orbs.filter((o) => o.kind === "hot").length ?? 0) === 1, roundPlay?.orbs);
const playersPlay = playing instanceof Error || playing.type !== "round" ? [] : playing.players;
const poseA = playersPlay.find((p) => p.id === youA?.id) ?? youA;
const orb: Orb | undefined = roundPlay?.orbs[0];

if (poseA && orb) {
  const away = Math.hypot(orb.x - poseA.x, orb.z - poseA.z) || 1;
  const far = { x: poseA.x - ((orb.x - poseA.x) / away) * 9, z: poseA.z - ((orb.z - poseA.z) / away) * 9 };
  let hopCollect = false;
  const hopWatch = (ev: MessageEvent) => {
    if (typeof ev.data !== "string") return;
    try {
      const event = JSON.parse(ev.data) as ServerEvent;
      if (event.type === "collect" && event.playerId === youA?.id) hopCollect = true;
    } catch {
      /* ignore */
    }
  };
  b.addEventListener("message", hopWatch);
  a.send(JSON.stringify({ type: "move", x: far.x, z: far.z }));
  await sleep(200);
  b.removeEventListener("message", hopWatch);
  check("a 9-unit hop does not collect", hopCollect === false, hopCollect);
}

const collected = await new Promise<{ ok: boolean; gold: number }>((resolve) => {
  if (!poseA || !orb) {
    resolve({ ok: false, gold: 0 });
    return;
  }
  const timer = setTimeout(() => resolve({ ok: false, gold: 0 }), 8_000);
  b.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    try {
      const event = JSON.parse(ev.data) as ServerEvent;
      if (event.type === "collect" && event.playerId === youA?.id) {
        clearTimeout(timer);
        resolve({ ok: event.score >= 1, gold: event.orbs.filter((o) => o.kind === "hot").length });
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
check("A collecting an orb is scored on B", collected.ok);
check("gold count stays exactly one after a collect", collected.gold === 1, collected.gold);

const presenceAfterLeave = waitFor(b, (e) => e.type === "presence" && e.players.length === 1);
a.close();
const left = await presenceAfterLeave.catch((err) => err as Error);
check(
  "A close leaves B a 1-player presence (no ghost)",
  left instanceof Error === false && left.type === "presence" && left.players.length === 1 && left.players[0]?.id === youB?.id,
  left instanceof Error ? left : left.type === "presence" ? left.players : left,
);

b.close();
await sleep(250);

const ticketC = (await mint(room)).ticket;
const c = openSocket(room, "Smoke C", ticketC);
const helloC = await waitFor(c, (e) => e.type === "hello").catch((err) => err as Error);
check(
  "empty room resets: C joins waiting round 0",
  helloC instanceof Error === false && helloC.type === "hello" && helloC.round.phase === "waiting" && helloC.round.round === 0,
  helloC instanceof Error ? helloC : helloC.type === "hello" ? helloC.round : helloC,
);
c.close();

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
