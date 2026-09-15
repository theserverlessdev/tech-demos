// Smoke: bun run scripts/smoke.ts [baseUrl]
import type { Attachment, ChatMessage, Health, RoomSummary, Session } from "../src/shared/types";

const base = (process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");

let failures = 0;
function check(label: string, ok: unknown, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

const jar = new Map<string, string>();

function cookieHeader(): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function rememberCookies(res: Response) {
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const list = raw.length ? raw : [res.headers.get("set-cookie")].filter((v): v is string => Boolean(v));
  for (const line of list) {
    const [pair] = line.split(";");
    const eq = pair?.indexOf("=") ?? -1;
    if (eq > 0) jar.set(pair!.slice(0, eq), pair!.slice(eq + 1));
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}) {
  const headers: Record<string, string> = {};
  const cookie = cookieHeader();
  if (cookie) headers.cookie = cookie;
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${base}/api${path}`, { method: init.method ?? "GET", headers, body });
  rememberCookies(res);
  const text = await res.text();
  let data: T | null = null;
  try {
    data = JSON.parse(text) as T;
  } catch {
    data = null;
  }
  return { status: res.status, data, text, res };
}

console.log(`Target: ${base}`);

const health = await call<Health>("/health");
check("health is ok with a seeded lobby", health.status === 200 && health.data?.ok && (health.data.messages ?? 0) >= 2, health.data);

const session = await call<{ session: Session }>("/session", { method: "POST", body: { displayName: "Smoke Bot" } });
check("KV session stores the display name", session.status === 200 && session.data?.session.displayName === "Smoke Bot", session.data);
check("session cookie was set", jar.has("edgechat_sid"), [...jar.keys()]);

const rooms = await call<{ rooms: RoomSummary[] }>("/rooms");
check("lists the lobby room", rooms.status === 200 && Boolean(rooms.data?.rooms.some((r) => r.id === "lobby")), rooms.data?.rooms.map((r) => r.id));

const history = await call<{ messages: ChatMessage[] }>("/rooms/lobby/messages");
check("lobby history loads from D1", history.status === 200 && (history.data?.messages.length ?? 0) >= 2, history.data?.messages.length);

const sent = await call<{ message: ChatMessage }>("/rooms/lobby/messages", {
  method: "POST",
  body: { body: "Smoke REST ping — should persist in D1." },
});
check("REST send persists a message", sent.status === 201 && sent.data?.message.body.includes("Smoke REST"), sent.data);

const after = await call<{ messages: ChatMessage[] }>("/rooms/lobby/messages");
check(
  "history survives a second read",
  Boolean(after.data?.messages.some((m) => m.id === sent.data?.message.id)),
  after.data?.messages.slice(-2).map((m) => m.body),
);

const blob = new Blob(["smoke attachment from edgechat\n"], { type: "text/plain" });
const form = new FormData();
form.set("file", blob, "smoke.txt");
form.set("caption", "R2 round-trip from smoke.ts");
const uploaded = await call<{ message: ChatMessage; attachment: Attachment }>("/rooms/lobby/upload", { method: "POST", form });
check("upload stores a file and posts a message", uploaded.status === 201 && uploaded.data?.attachment.filename === "smoke.txt", uploaded.data);

if (uploaded.data?.attachment) {
  const file = await fetch(`${base}/api/files/${uploaded.data.attachment.id}`, { headers: { cookie: cookieHeader() } });
  const body = await file.text();
  check("uploaded file round-trips from R2", file.ok && body.includes("smoke attachment"), { status: file.status, bytes: body.length });
}

const seed = history.data?.messages.find((m) => m.attachment?.id === "att_lobby_seed");
if (seed?.attachment) {
  const file = await fetch(`${base}/api/files/${seed.attachment.id}`);
  const body = await file.text();
  check("seed attachment downloads from R2", file.ok && body.includes("Durable Objects fan out"), { status: file.status, bytes: body.length });
} else {
  check("seed attachment downloads from R2", false, "missing att_lobby_seed");
}

const wsUrl = base.replace(/^http/, "ws") + "/ws/lobby";
const wsOk = await new Promise<boolean>((resolve) => {
  const ws = new WebSocket(wsUrl);
  const timer = setTimeout(() => {
    ws.close();
    resolve(false);
  }, 8_000);
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "send", body: "Smoke WebSocket ping — should fan out and persist." }));
  });
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    try {
      const event = JSON.parse(ev.data) as { type?: string; message?: ChatMessage; messages?: ChatMessage[] };
      if (event.type === "message" && event.message?.body.includes("Smoke WebSocket ping")) {
        clearTimeout(timer);
        ws.close();
        resolve(true);
      }
      if (event.type === "hello") {
        /* wait for our echo */
      }
    } catch {
      /* ignore */
    }
  });
  ws.addEventListener("error", () => {
    clearTimeout(timer);
    resolve(false);
  });
});
check("WebSocket send echoes through the Durable Object", wsOk);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
