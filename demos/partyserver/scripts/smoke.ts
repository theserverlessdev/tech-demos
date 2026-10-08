// Smoke: bun run scripts/smoke.ts [baseUrl]
import YProvider from "y-partyserver/provider";
import * as Y from "yjs";
import { CLOSE_FULL, CLOSE_RATE, MAX_CONNECTIONS, MAX_STROKES, PARTY, ROOM_ID, type CreatedRoom, type RoomStatus } from "../src/shared/protocol";
import { TEST_TURNSTILE_SECRET, TEST_TURNSTILE_SITE_KEY, assessTurnstile } from "../src/worker/turnstile";

const base = (process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const DUMMY = "XXXX.DUMMY.TOKEN.XXXX";

let failures = 0;
function check(label: string, ok: unknown, detail?: unknown): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

async function call(path: string, init: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${base}${path}`, { method: init.method ?? "GET", headers, body });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: res.status, data, text };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
check(
  "a real pair is open without the local flag",
  assessTurnstile({ secret: "real-secret", siteKey: "real-site", allowTestCredentials: false }) === "open",
);

console.log(`Target: ${base}`);

const health = await call("/api/health");
check("health", health.status === 200 && (health.data as { ok?: boolean })?.ok === true, health.data);
const prefixed = await call("/demos/partyserver/api/health");
check("health under /demos/partyserver", prefixed.status === 200 && (prefixed.data as { hibernation?: boolean })?.hibernation === true, prefixed.data);

const page = await fetch(`${base}/demos/partyserver/`);
const html = await page.text();
check("prefixed page is the board", page.ok && html.includes("Partyboard") && html.includes("assets/app.js"), { status: page.status });

const missing = await call("/api/rooms", { method: "POST", body: {} });
check("create without a token is rejected", missing.status === 400, missing.data);

const bad = await call("/api/rooms", { method: "POST", body: { turnstileToken: "not-a-token" } });
check("create with a bad token is rejected", bad.status === 400, bad.data);

const created = await call("/api/rooms", { method: "POST", body: { turnstileToken: DUMMY } });
const room = created.data as CreatedRoom | null;
check("create with the dummy token", created.status === 201 && !!room && ROOM_ID.test(room.id), created.data);
if (!room?.id) {
  console.error("Cannot continue without a room.");
  process.exit(1);
}

const status = await call(`/api/rooms/${room.id}`);
const meta = status.data as RoomStatus | null;
check("room status has an alarm at expiry", status.status === 200 && meta?.alarmAt === room.expiresAt && meta.expiresAt > Date.now(), meta);

const unknown = await call("/api/rooms/not-a-room");
check("unknown room id is 404", unknown.status === 404, unknown.status);

const host = base.replace(/^https?:\/\//, "");
const docA = new Y.Doc();
const docB = new Y.Doc();
const providerA = new YProvider(host, room.id, docA, { party: PARTY, disableBc: true });
const providerB = new YProvider(`${host}/demos/partyserver`, room.id, docB, { party: PARTY, disableBc: true });

const synced = await Promise.race([
  waitSynced(providerB),
  sleep(8000).then(() => false),
]);
check("second client synced through the prefixed socket", synced === true);

docA.getMap("strokes").set(
  "stroke01",
  JSON.stringify({ id: "stroke01", color: "#c2410c", size: 6, points: [100, 100, 4000, 7000], client: "smokecli" }),
);
const seen = await waitFor(() => docB.getMap("strokes").has("stroke01"), 8000);
check("stroke synced to the other client", seen);

providerA.disconnect();
providerB.disconnect();
await sleep(800);
const stored = await call(`/api/rooms/${room.id}`);
const storedMeta = stored.data as RoomStatus | null;
check("snapshot bytes were written to DO storage", (storedMeta?.docBytes ?? 0) > 0, storedMeta);

const docC = new Y.Doc();
const providerC = new YProvider(host, room.id, docC, { party: PARTY, disableBc: true });
const persisted = await waitFor(() => docC.getMap("strokes").has("stroke01"), 8000);
check("stroke survived a reconnect from DO storage", persisted);
providerC.disconnect();

let paced = 0;
const docD = new Y.Doc();
const providerD = new YProvider(host, room.id, docD, { party: PARTY, disableBc: true });
await waitFor(() => providerD.wsconnected, 8000);
for (let i = 0; i < MAX_STROKES + 5; i++) {
  const id = `s${String(i).padStart(6, "0")}`;
  docD.getMap("strokes").set(id, JSON.stringify({ id, color: "#e7e5e4", size: 3, points: [i, i, i + 10, i + 20], client: "smokecli" }));
  paced++;
  if (paced % 25 === 0) await sleep(500);
}
await sleep(600);
const peer = new Y.Doc();
const providerE = new YProvider(host, room.id, peer, { party: PARTY, disableBc: true });
await waitFor(() => peer.getMap("strokes").size >= MAX_STROKES, 8000);
await sleep(500);
check("stroke cap stops the room growing", peer.getMap("strokes").size === MAX_STROKES, peer.getMap("strokes").size);
providerD.disconnect();
providerE.disconnect();
await sleep(600);

const sockets: WebSocket[] = [];
for (let i = 0; i < MAX_CONNECTIONS; i++) {
  sockets.push(await openSocket(`${base.replace(/^http/, "ws")}/parties/board-room/${room.id}?_pk=cap${i}`));
}
const overflow = await socketCloseCode(`${base.replace(/^http/, "ws")}/parties/board-room/${room.id}?_pk=overflow`);
check("ninth connection is refused", overflow === CLOSE_FULL, overflow);

const flooded = sockets[0];
if (flooded) {
  const closed = new Promise<number>((resolve) => {
    flooded.addEventListener("close", (event) => resolve(event.code));
  });
  for (let i = 0; i < 400; i++) flooded.send(new Uint8Array([0, 1, 2, 3]));
  const code = await Promise.race([closed, sleep(4000).then(() => 0)]);
  check("frame flood closes the socket", code === CLOSE_RATE, code);
}
for (const socket of sockets) {
  try {
    socket.close();
  } catch {
    /* already closed */
  }
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");

function waitSynced(provider: YProvider): Promise<boolean> {
  return new Promise((resolve) => {
    if (provider.synced) {
      resolve(true);
      return;
    }
    provider.on("synced", (state: boolean) => {
      if (state) resolve(true);
    });
  });
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await sleep(50);
  }
  return false;
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error(`open timeout ${url}`)), 5000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`open error ${url}`));
    });
  });
}

function socketCloseCode(url: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => resolve(0), 5000);
    ws.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve(event.code);
    });
  });
}
