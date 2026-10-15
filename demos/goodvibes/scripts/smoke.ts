// Smoke: bun run scripts/smoke.ts [baseUrl]
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import { DEEP_JOIN_MAX, deepBackoffMs, deepJoinExhausted, shouldKeepJoinError } from "../src/client/join-gate";
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

function wsMaskFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i]! ^= mask[i % 4]!;
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

type RawWs = {
  sendBinary: (bytes: Uint8Array) => void;
  destroy: () => void;
  waitHello: () => Promise<ServerEvent>;
};

/** Client that ignores Close frames so the TCP connection stays up (G1). */
function openRawSocket(room: string, name: string, ticket: string): Promise<RawWs> {
  const url = new URL(`${base.replace(/^http/, "ws")}/ws/${encodeURIComponent(room)}?${new URLSearchParams({ name, ticket })}`);
  const key = randomBytes(16).toString("base64");
  const expected = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  const origin = base.replace(/\/$/, "");
  return new Promise((resolve, reject) => {
    let settled = false;
    const port = Number(url.port || (url.protocol === "wss:" ? 443 : 80));
    const socket = net.connect({ host: url.hostname, port }, () => {
      socket.write(
        `GET ${url.pathname}${url.search} HTTP/1.1\r\n` +
          `Host: ${url.host}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `Origin: ${origin}\r\n` +
          `\r\n`,
      );
    });
    let buf = Buffer.alloc(0);
    let open = false;
    let hello: ServerEvent | null = null;
    let helloWait: ((event: ServerEvent) => void) | null = null;
    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
      socket.destroy();
    };
    socket.setTimeout(12_000, () => {
      if (!open) fail(new Error("raw socket handshake timeout"));
    });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!open) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        const head = buf.subarray(0, idx).toString("utf8");
        buf = buf.subarray(idx + 4);
        if (!head.startsWith("HTTP/1.1 101") || !head.includes(expected)) {
          fail(new Error(`upgrade failed: ${head.slice(0, 180)}`));
          return;
        }
        open = true;
        socket.setTimeout(0);
        settled = true;
        resolve({
          sendBinary: (bytes) => {
            socket.write(wsMaskFrame(2, Buffer.from(bytes)));
          },
          destroy: () => socket.destroy(),
          waitHello: () => (hello ? Promise.resolve(hello) : new Promise((r) => { helloWait = r; })),
        });
      }
      while (open && buf.length >= 2) {
        const opcode = buf[0]! & 0x0f;
        const second = buf[1]!;
        const masked = (second & 0x80) !== 0;
        let len = second & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buf.length < offset + maskLen + len) return;
        let payload = Buffer.from(buf.subarray(offset + maskLen, offset + maskLen + len));
        if (masked) {
          const mask = buf.subarray(offset, offset + 4);
          for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
        }
        buf = buf.subarray(offset + maskLen + len);
        if (opcode === 0x8) continue;
        if (opcode === 0x9) {
          socket.write(wsMaskFrame(0xa, payload));
          continue;
        }
        if (opcode !== 0x1) continue;
        try {
          const event = JSON.parse(payload.toString("utf8")) as ServerEvent;
          if (event.type === "hello" && !hello) {
            hello = event;
            helloWait?.(event);
          }
        } catch {
          /* ignore */
        }
      }
    });
    socket.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
  });
}

function waitClose(ws: WebSocket, ms = 8_000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("close timeout")), ms);
    ws.addEventListener("close", (ev) => {
      clearTimeout(timer);
      resolve({ code: ev.code, reason: ev.reason });
    });
  });
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
check(
  "deep-link backoff is 0 then 400ms then 800ms",
  deepBackoffMs(0) === 0 && deepBackoffMs(1) === 400 && deepBackoffMs(2) === 800,
  [deepBackoffMs(0), deepBackoffMs(1), deepBackoffMs(2)],
);
check("deep-link ticket retries cap at 3", deepJoinExhausted(DEEP_JOIN_MAX - 1) === false && deepJoinExhausted(DEEP_JOIN_MAX) === true);
check("Turnstile callback keeps a warn status", shouldKeepJoinError("warn") && !shouldKeepJoinError("ok") && !shouldKeepJoinError("idle"));

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
await sleep(150);

const ticketFlood = (await mint("frame-budget")).ticket;
const flood = openSocket("frame-budget", "Flood", ticketFlood);
const helloFlood = await waitFor(flood, (e) => e.type === "hello").catch((err) => err as Error);
check("frame-budget socket receives hello", helloFlood instanceof Error === false && (helloFlood as ServerEvent).type === "hello");
const floodClosed = waitClose(flood);
for (let i = 0; i < 100; i++) flood.send(new Uint8Array(1));
const floodEnd = await floodClosed.catch((err) => err as Error);
check(
  "100 binary frames close the socket with 1008",
  floodEnd instanceof Error === false && floodEnd.code === 1008,
  floodEnd instanceof Error ? floodEnd : { code: floodEnd.code, reason: floodEnd.reason },
);

const ticketOver = (await mint("frame-oversize")).ticket;
const over = openSocket("frame-oversize", "Oversize", ticketOver);
await waitFor(over, (e) => e.type === "hello");
const overClosed = waitClose(over);
over.send("x".repeat(600));
const overEnd = await overClosed.catch((err) => err as Error);
check(
  "a >512-byte text frame closes with 1008",
  overEnd instanceof Error === false && overEnd.code === 1008,
  overEnd instanceof Error ? overEnd : { code: overEnd.code, reason: overEnd.reason },
);

const ghostRoom = `g1-ghost-${Date.now()}`;
const ticketWatch = (await mint(ghostRoom)).ticket;
const watch = openSocket(ghostRoom, "Watch", ticketWatch);
const helloWatch = await waitFor(watch, (e) => e.type === "hello").catch((err) => err as Error);
check("G1 watcher receives hello", helloWatch instanceof Error === false && helloWatch.type === "hello", helloWatch);

const ticketRaw = (await mint(ghostRoom)).ticket;
const raw = await openRawSocket(ghostRoom, "Raw", ticketRaw).catch((err) => err as Error);
check("G1 raw client upgrades", raw instanceof Error === false, raw instanceof Error ? raw.message : "ok");
let rawYou: Player | null = null;
if (!(raw instanceof Error)) {
  const helloRaw = await raw.waitHello().catch((err) => err as Error);
  check("G1 raw client receives hello", helloRaw instanceof Error === false && helloRaw.type === "hello", helloRaw);
  rawYou = helloRaw instanceof Error || helloRaw.type !== "hello" ? null : helloRaw.you;
  const ghostGone = waitFor(
    watch,
    (e) =>
      (e.type === "leave" && e.id === rawYou?.id) ||
      (e.type === "presence" && e.players.length === 1 && e.players[0]?.name === "Watch"),
  );
  raw.sendBinary(new Uint8Array(1));
  const gone = await ghostGone.catch((err) => err as Error);
  check(
    "G1 1008 leave/presence drops Raw while TCP stays open",
    gone instanceof Error === false,
    gone instanceof Error ? gone.message : gone,
  );

  const ticketThird = (await mint(ghostRoom)).ticket;
  const third = openSocket(ghostRoom, "Third", ticketThird);
  const helloThird = await waitFor(third, (e) => e.type === "hello").catch((err) => err as Error);
  const thirdPlayers =
    helloThird instanceof Error || helloThird.type !== "hello" ? [] : helloThird.players.map((p: Player) => p.name);
  check(
    "G1 same-IP third join succeeds (closed Raw does not count)",
    helloThird instanceof Error === false && helloThird.type === "hello" && !thirdPlayers.includes("Raw"),
    helloThird instanceof Error ? helloThird.message : thirdPlayers,
  );
  third.close();
  raw.destroy();
}
watch.close();

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
