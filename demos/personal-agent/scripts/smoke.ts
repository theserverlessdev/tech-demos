// Smoke: bun run scripts/smoke.ts [baseUrl]
import type { ChatReply, ConfigResponse, HealthResponse, NoteDetail, NoteSummary, ResearchReply, ThreadMessage } from "../src/shared/types";

const base = (process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

let failures = 0;
function check(label: string, ok: unknown, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

function visitor(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return [...bytes].map((byte) => alphabet[byte % 36]).join("");
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${base}${path}`, { method: init.method ?? "GET", headers, body });
  const text = await res.text();
  let data: T | null = null;
  try {
    data = JSON.parse(text) as T;
  } catch {
    data = null;
  }
  return { status: res.status, data, text };
}

console.log(`Target: ${base}`);

const health = await call<HealthResponse>("/api/health");
check("health is ok and turnstile is configured", health.status === 200 && health.data?.ok === true && health.data.turnstile === "configured", health.data);

const config = await call<ConfigResponse>("/api/config");
check("config publishes the test site key and an allowlist", config.status === 200 && Boolean(config.data?.siteKey) && (config.data?.allowlist.length ?? 0) >= 4, {
  siteKey: config.data?.siteKey,
  hosts: config.data?.allowlist.length,
});

const id = visitor();
const other = visitor();
const blocked = await call("/api/chat", { method: "POST", body: { visitorId: id, message: "hello there friend" } });
check("chat without turnstile is rejected", blocked.status === 403, blocked.data);

const privateHost = await call("/api/research", {
  method: "POST",
  body: {
    visitorId: id,
    question: "What is on the metadata address?",
    urls: ["https://127.0.0.1/latest/meta-data", "http://169.254.169.254/latest/meta-data"],
    turnstileToken: TOKEN,
  },
});
check("research rejects private and non-https targets", privateHost.status === 400, privateHost.data);

const saved = await call<{ note: NoteSummary; duplicate: boolean }>("/api/notes", {
  method: "POST",
  body: {
    visitorId: id,
    title: "Color palette",
    body: "I like the graphite background and the ember accent color palette.",
    turnstileToken: TOKEN,
  },
});
check("note is stored", saved.status === 200 && saved.data?.note.title === "Color palette", saved.data);
const noteId = saved.data?.note.id;

const listed = await call<{ notes: NoteSummary[] }>(`/api/notes?visitorId=${id}`);
check("note list contains the saved title", listed.status === 200 && listed.data?.notes.some((note) => note.id === noteId), listed.data);

if (noteId) {
  const detail = await call<NoteDetail>(`/api/notes/${noteId}?visitorId=${id}`);
  check("note body round-trips from R2", detail.status === 200 && (detail.data?.body.includes("ember accent") ?? false), detail.data?.body);
  const foreign = await call(`/api/notes/${noteId}?visitorId=${other}`);
  check("another visitor cannot read the note", foreign.status === 404, foreign.data);
}

const chat = await call<ChatReply>("/api/chat", {
  method: "POST",
  body: { visitorId: id, message: "What color palette do I like?", turnstileToken: TOKEN },
});
const recalled = chat.data?.recalled.some((hit) => hit.title === "Color palette" && hit.score > 0) ?? false;
check("chat recalls the note title and a score", chat.status === 200 && recalled && (chat.data?.reply.length ?? 0) > 20, {
  status: chat.status,
  source: chat.data?.source,
  recalled: chat.data?.recalled,
  preview: chat.data?.reply.slice(0, 120),
});

const thread = await call<{ messages: ThreadMessage[] }>(`/api/thread?visitorId=${id}`);
check("thread keeps the user turn and the reply", (thread.data?.messages.length ?? 0) >= 2, thread.data?.messages.length);

const research = await call<ResearchReply>("/api/research", {
  method: "POST",
  body: {
    visitorId: id,
    question: "How does the Fetch API send a request?",
    urls: [
      "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
      "https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/api/fetch_api/index.md",
    ],
    turnstileToken: TOKEN,
  },
});
const cited = research.data?.citations.filter((item) => item.ok).length ?? 0;
check("research returns a summary and at least one citation", research.status === 200 && cited >= 1 && (research.data?.summary.length ?? 0) > 40, {
  status: research.status,
  source: research.data?.source,
  citations: research.data?.citations,
  preview: research.data?.summary.slice(0, 140),
});

if (noteId) {
  const removed = await call<{ deleted: true }>(`/api/notes/${noteId}`, {
    method: "DELETE",
    body: { visitorId: id, turnstileToken: TOKEN },
  });
  check("delete removes the note", removed.status === 200 && removed.data?.deleted === true, removed.data);
  const again = await call<ChatReply>("/api/chat", {
    method: "POST",
    body: { visitorId: id, message: "What color palette do I like?", turnstileToken: TOKEN },
  });
  const still = again.data?.recalled.some((hit) => hit.title === "Color palette") ?? false;
  check("deleted note is not recalled", again.status === 200 && !still, again.data?.recalled);
}

const emptyOther = await call<{ notes: NoteSummary[] }>(`/api/notes?visitorId=${other}`);
check("second visitor notebook is empty", emptyOther.status === 200 && emptyOther.data?.notes.length === 0, emptyOther.data);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
