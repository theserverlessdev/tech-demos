// Smoke: bun run scripts/smoke.ts [baseUrl]
import type { Attachment, ChatMessage, Health, RoomSummary, SessionResponse } from "../src/shared/types";
import { TURNSTILE_DUMMY_TOKEN } from "../src/worker/turnstile";

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

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown; form?: FormData; headers?: Record<string, string>; cookies?: boolean } = {},
) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.cookies !== false) {
    const cookie = cookieHeader();
    if (cookie) headers.cookie = cookie;
  }
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${base}/api${path}`, { method: init.method ?? "GET", headers, body });
  if (init.cookies !== false) rememberCookies(res);
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

jar.clear();
const peek = await call<SessionResponse>("/session", { cookies: false });
check("GET /session without a cookie does not mint KV", peek.status === 200 && peek.data?.session.persisted === false, peek.data);
check("cookieless GET /session sets no cookie", !peek.res.headers.get("set-cookie"), peek.res.headers.get("set-cookie"));

const session = await call<SessionResponse>("/session", {
  method: "POST",
  body: { displayName: "Smoke Bot", turnstileToken: TURNSTILE_DUMMY_TOKEN },
});
check("Turnstile-gated POST /session stores the display name", session.status === 200 && session.data?.session.displayName === "Smoke Bot", session.data);
check("session cookie was set", jar.has("edgechat_sid"), [...jar.keys()]);
check("API session omits the cookie secret", session.data?.session && !("id" in session.data.session), session.data?.session);

const stolen = jar.get("edgechat_sid") ?? "";
const hijack = await call<SessionResponse>("/session", {
  method: "POST",
  cookies: false,
  headers: { "x-edgechat-session": stolen },
  body: { displayName: "Renamed by attacker", turnstileToken: TURNSTILE_DUMMY_TOKEN },
});
check(
  "x-edgechat-session header cannot take over a session",
  hijack.status === 200 && hijack.data?.session.displayName === "Renamed by attacker" && hijack.data.session.publicId !== session.data?.session.publicId,
  { hijack: hijack.data?.session, victim: session.data?.session },
);

const victim = await call<SessionResponse>("/session");
check("victim cookie still has the original name", victim.status === 200 && victim.data?.session.displayName === "Smoke Bot", victim.data);

const rooms = await call<{ rooms: RoomSummary[] }>("/rooms");
check("lists the lobby room first or at all", rooms.status === 200 && Boolean(rooms.data?.rooms.some((r) => r.id === "lobby")), rooms.data?.rooms.map((r) => r.id));

const missing = await call<{ error?: { code: string } }>("/rooms/spam-drive-by/messages");
check("GET missing room is 404 and does not create it", missing.status === 404, missing.data);
const afterSpam = await call<{ rooms: RoomSummary[] }>("/rooms");
check("spam room is absent from the list", afterSpam.status === 200 && !afterSpam.data?.rooms.some((r) => r.id === "spam-drive-by"), afterSpam.data?.rooms.map((r) => r.id));

const badPath = await fetch(`${base}/api/rooms/%E0%A4`);
check("malformed percent-encoding is 400 not 500", badPath.status === 400, badPath.status);

const created404 = await call<{ error?: { code: string } }>("/rooms/created-by-404/nonsense");
check("unknown room sub-route 404s without creating the room", created404.status === 404, created404.data);

const hindi = await call<{ room: RoomSummary }>("/rooms", { method: "POST", body: { name: "नमस्ते" } });
check("non-Latin room names do not collapse to lobby", hindi.status === 201 && hindi.data?.room.id === "नमस्ते", hindi.data);

const history = await call<{ messages: ChatMessage[] }>("/rooms/lobby/messages");
check("lobby history loads from D1", history.status === 200 && (history.data?.messages.length ?? 0) >= 2, history.data?.messages.length);
check(
  "history exposes authorKey, not sessionId",
  Boolean(history.data?.messages.every((m) => typeof m.authorKey === "string" && !("sessionId" in m))),
  history.data?.messages[0],
);

const sent = await call<{ message: ChatMessage }>("/rooms/lobby/messages", {
  method: "POST",
  body: { body: "Smoke REST ping — should persist in D1." },
});
check("REST send persists a message", sent.status === 201 && sent.data?.message.body.includes("Smoke REST"), sent.data);
check("REST message authorKey matches the public id", sent.data?.message.authorKey === session.data?.session.publicId, sent.data?.message);

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
  check("non-image is served as an attachment", file.headers.get("content-disposition")?.startsWith("attachment"), file.headers.get("content-disposition"));
  check("non-image content-type is octet-stream", file.headers.get("content-type") === "application/octet-stream", file.headers.get("content-type"));
  check("file response has a sandbox CSP", file.headers.get("content-security-policy") === "default-src 'none'; sandbox", file.headers.get("content-security-policy"));
  check("file cache is public immutable", file.headers.get("cache-control") === "public, max-age=31536000, immutable", file.headers.get("cache-control"));
}

const seed = history.data?.messages.find((m) => m.attachment?.id === "att_lobby_seed");
if (seed?.attachment) {
  const file = await fetch(`${base}/api/files/${seed.attachment.id}`);
  const body = await file.text();
  check("seed attachment downloads from R2", file.ok && body.includes("Durable Objects fan out"), { status: file.status, bytes: body.length });
} else {
  check("seed attachment downloads from R2", false, "missing att_lobby_seed");
}

const spa = await fetch(`${base}/not-a-page`);
check("unknown paths are real 404s", spa.status === 404, spa.status);

const wsUrl = base.replace(/^http/, "ws") + "/ws/lobby";
const wsOk = await new Promise<boolean>((resolve) => {
  const ws = new WebSocket(wsUrl, { headers: { cookie: cookieHeader() } } as unknown as string[]);
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
      const event = JSON.parse(ev.data) as { type?: string; message?: ChatMessage };
      if (event.type === "message" && event.message?.body.includes("Smoke WebSocket ping")) {
        clearTimeout(timer);
        ws.close();
        resolve(true);
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

const evil = await fetch(base.replace(/^http/, "http") + "/ws/lobby", {
  headers: {
    Upgrade: "websocket",
    Connection: "Upgrade",
    Origin: "https://evil.example",
    cookie: cookieHeader(),
  },
});
check("evil Origin is rejected on upgrade", evil.status === 403 || evil.status === 426, evil.status);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
