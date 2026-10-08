// Smoke: bun run scripts/smoke.ts [baseUrl]
import type { LabConfig, RaceResult, RoomResponse, SayResult } from "../src/shared/types";

const base = (process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

let failures = 0;
let cookie = "";

function check(label: string, ok: unknown, detail?: unknown): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: T | null; text: string }> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${base}${path}`, { method: init.method ?? "GET", headers, body });
  const set = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") ?? ""];
  for (const item of set) {
    const part = item.split(";")[0] ?? "";
    if (part.startsWith("actor_lab=")) cookie = part;
  }
  const text = await res.text();
  let data: T | null = null;
  try {
    data = JSON.parse(text) as T;
  } catch {
    data = null;
  }
  return { status: res.status, data, text };
}

async function race(mode: "interleaved" | "serialized", n: number): Promise<RaceResult | null> {
  const armed = await call<{ runId: string }>("/api/race/arm", { method: "POST", body: { n, mode, token: TOKEN } });
  if (armed.status !== 200 || !armed.data?.runId) return null;
  const steps = await Promise.all(
    Array.from({ length: n }, (_, racer) => call(`/api/race/step`, { method: "POST", body: { runId: armed.data!.runId, racer } })),
  );
  if (steps.some((step) => step.status !== 200)) return null;
  const result = await call<RaceResult>(`/api/race/result?runId=${armed.data.runId}`);
  return result.status === 200 ? result.data : null;
}

console.log(`Target: ${base}`);

const health = await call<{ ok: boolean; model: string; ai: string }>("/api/health");
check("health is ok", health.status === 200 && health.data?.ok === true, health.data);

const cfg = await call<LabConfig>("/api/config");
check("config reports the model and limits", cfg.status === 200 && cfg.data?.ok && cfg.data.limits.raceMax === 6, cfg.data);

const denied = await call("/api/race/arm", { method: "POST", body: { n: 4, mode: "interleaved" } });
check("race without a Turnstile token is rejected", denied.status === 403 || denied.status === 503, { status: denied.status, body: denied.data });

const badN = await call("/api/race/arm", { method: "POST", body: { n: 1, mode: "interleaved", token: TOKEN } });
check("n below 2 is rejected", badN.status === 400, badN.data);

let interleaved: RaceResult | null = null;
for (let attempt = 1; attempt <= 3 && !(interleaved && interleaved.lost > 0 && interleaved.overlapped); attempt++) {
  interleaved = await race("interleaved", 4);
  console.log(`      interleaved attempt ${attempt}: lost=${interleaved?.lost} overlapped=${interleaved?.overlapped} source=${interleaved?.awaitSource} actual=${interleaved?.actual}`);
}
check("interleaved run loses updates while waits overlap", Boolean(interleaved && interleaved.lost > 0 && interleaved.overlapped), interleaved?.summary);

const serialized = await race("serialized", 4);
check("serialized mailbox reaches 4 with no overlap", Boolean(serialized && serialized.actual === 4 && serialized.lost === 0 && !serialized.overlapped), serialized);

const page = await fetch(`${base}/`, { headers: cookie ? { cookie } : {} });
check("page renders the race lab", page.ok && (await page.text()).includes("Actor lab"), { status: page.status });

const created = await call<RoomResponse>("/api/rooms", { method: "POST", body: {} });
check("create room returns a code", created.status === 201 && /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(created.data?.code ?? ""), created.data?.code);
const code = created.data?.code ?? "";

const said = code
  ? await call<SayResult & { code: string }>(`/api/rooms/${code}/say`, {
      method: "POST",
      body: { name: "Smoke", text: "Persist this line.", ask: false },
    })
  : { status: 0, data: null, text: "" };
check("say stores a human message", said.status === 201 && said.data?.human.text === "Persist this line.", said.data?.human);

const scratched = code
  ? await call<RoomResponse>(`/api/rooms/${code}/scratch`, { method: "POST", body: { text: "only in memory" } })
  : { status: 0, data: null, text: "" };
check("scratch is visible before evict", scratched.status === 200 && scratched.data?.scratch === "only in memory", scratched.data?.scratch);

let fanout = false;
if (code) {
  const left = new WebSocket(`${base.replace(/^http/, "ws")}/api/rooms/${code}/socket?name=Left`);
  const right = new WebSocket(`${base.replace(/^http/, "ws")}/api/rooms/${code}/socket?name=Right`);
  const heard = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 4_000);
    right.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string" || !ev.data.includes("fan-out")) return;
      clearTimeout(timer);
      resolve(true);
    });
  });
  await Promise.all([opened(left), opened(right)]);
  left.send(JSON.stringify({ type: "say", text: "fan-out", ask: false }));
  fanout = await heard;
  left.close();
  right.close();
}
check("a second socket hears the say", fanout);

const locked = code
  ? await call(`/api/rooms/${code}/say`, { method: "POST", body: { name: "Smoke", text: "Ask anyway.", ask: true } })
  : { status: 0, data: null, text: "" };
check("ask without unlock is rejected", locked.status === 403, locked.data);

const unlocked = code
  ? await call<RoomResponse>(`/api/rooms/${code}/unlock`, { method: "POST", body: { token: TOKEN } })
  : { status: 0, data: null, text: "" };
check("unlock accepts the test token", unlocked.status === 200 && (unlocked.data?.aiUntil ?? 0) > Date.now(), unlocked.status);

const asked = code
  ? await call<SayResult>(`/api/rooms/${code}/say`, { method: "POST", body: { name: "Smoke", text: "What is an input gate?", ask: true } })
  : { status: 0, data: null, text: "" };
check(
  "ask returns an actor line (Workers AI or fallback)",
  asked.status === 201 && (asked.data?.actor?.text.length ?? 0) > 10,
  { source: asked.data?.actor?.source, preview: asked.data?.actor?.text.slice(0, 80) },
);

const evicted = code ? await call<RoomResponse>(`/api/rooms/${code}/evict`, { method: "POST", body: {} }) : { status: 0, data: null, text: "" };
const kept = evicted.data?.messages.some((message) => message.text === "Persist this line.") ?? false;
check("simulate evict keeps SQLite messages and drops scratch", evicted.status === 200 && evicted.data?.scratch === "" && evicted.data?.memory === "reloaded" && kept, {
  memory: evicted.data?.memory,
  scratch: evicted.data?.scratch,
  messages: evicted.data?.messages.length,
});

const missing = await call("/api/rooms/ZZZZZZ");
check("unknown room is 404", missing.status === 404, missing.data);

const huge = code
  ? await call(`/api/rooms/${code}/say`, { method: "POST", body: { name: "Smoke", text: "x".repeat(501), ask: false } })
  : { status: 0, data: null, text: "" };
check("over-long message is rejected", huge.status === 413, huge.status);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");

function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("socket failed")));
  });
}
