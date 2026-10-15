// Smoke: bun run scripts/smoke.ts [baseUrl]
import type {
  ChatReply,
  ConfigResponse,
  HealthResponse,
  NoteDetail,
  NoteSaveReply,
  ResearchReply,
  ThreadMessage,
} from "../src/shared/types";

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

async function call<T>(path: string, init: { method?: string; body?: unknown; visitorToken?: string } = {}) {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  if (init.visitorToken) headers["x-visitor-token"] = init.visitorToken;
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

const unknown = await call("/api/does-not-exist");
check("unknown GET is 404 before a visitor Durable Object is touched", unknown.status === 404, unknown.data);

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
check("research rejects private and non-https targets before Turnstile", privateHost.status === 400, privateHost.data);

const unsignedSession = await call<{ noteCount: number; messages?: unknown }>(`/api/session?visitorId=${id}`);
check("unsigned GET session is empty and ignores the query string", unsignedSession.status === 200 && unsignedSession.data?.noteCount === 0, unsignedSession.data);

const twoPart = await call<{ noteCount: number }>("/api/session", { visitorToken: `${id}.${"ab".repeat(32)}` });
check("two-part token does not unlock a session", twoPart.status === 200 && twoPart.data?.noteCount === 0, twoPart.data);

const pastExp = String(Date.now() - 60_000);
const expired = await call<{ noteCount: number }>("/api/session", { visitorToken: `${id}.${pastExp}.${"ab".repeat(32)}` });
check("expired token does not unlock a session", expired.status === 200 && expired.data?.noteCount === 0 && /^\d{11,15}$/.test(pastExp), expired.data);

const emptyChat = await call("/api/chat", { method: "POST", body: { visitorId: id, message: "   ", turnstileToken: TOKEN } });
check("empty chat is 400 before a Durable Object is touched", emptyChat.status === 400, emptyChat.data);

const emptyNote = await call("/api/notes", { method: "POST", body: { visitorId: id, title: "", body: "no title", turnstileToken: TOKEN } });
check("empty note title is 400 before a Durable Object is touched", emptyNote.status === 400, emptyNote.data);

const saved = await call<NoteSaveReply>("/api/notes", {
  method: "POST",
  body: {
    visitorId: id,
    title: "Color palette",
    body: "I like the graphite background and the ember accent color palette.",
    turnstileToken: TOKEN,
  },
});
const grant = saved.data?.visitorToken;
const grantParts = grant?.split(".") ?? [];
check("note is stored and returns an id.exp.sig token", saved.status === 200 && saved.data?.note.title === "Color palette" && grantParts.length === 3 && /^\d{11,15}$/.test(grantParts[1] ?? ""), {
  title: saved.data?.note.title,
  tokenParts: grantParts.length,
});
const noteId = saved.data?.note?.id;

const listed = await call<{ notes: { id: string }[] }>("/api/notes", { visitorToken: grant });
check("note list contains the saved title", listed.status === 200 && listed.data?.notes.some((note) => note.id === noteId), listed.data);

const leaked = await call<{ notes: { id: string }[] }>(`/api/notes?visitorId=${id}`);
check("query-string visitor id does not unlock notes", leaked.status === 200 && (leaked.data?.notes.length ?? 0) === 0, leaked.data);

if (noteId) {
  const detail = await call<NoteDetail>(`/api/notes/${noteId}`, { visitorToken: grant });
  check("note body round-trips from R2", detail.status === 200 && (detail.data?.body.includes("ember accent") ?? false), detail.data?.body);
  const foreign = await call(`/api/notes/${noteId}`);
  check("a note is hidden without a signed visitor token", foreign.status === 404, foreign.data);
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

const thread = await call<{ messages: ThreadMessage[] }>("/api/thread", { visitorToken: grant });
check("thread keeps the user turn and the reply", (thread.data?.messages.length ?? 0) >= 2, thread.data?.messages.length);

const catalog = await call<ResearchReply>("/api/research", {
  method: "POST",
  body: {
    visitorId: id,
    question: "How do Durable Objects keep state?",
    turnstileToken: TOKEN,
  },
});
const catalogCited = catalog.data?.citations.filter((item) => item.ok).length ?? 0;
const catalogTitles = catalog.data?.citations.filter((item) => item.ok).map((item) => item.title) ?? [];
const catalogHasPageTitles = catalogTitles.length >= 2 && catalogTitles.every((title) => title.length > 0 && title !== "developers.cloudflare.com");
check("docs catalog answers the placeholder question", catalog.status === 200 && catalogCited >= 2 && (catalog.data?.summary.length ?? 0) > 40, {
  status: catalog.status,
  source: catalog.data?.source,
  citations: catalog.data?.citations,
  preview: catalog.data?.summary.slice(0, 140),
});
check("catalog citations use page titles, not the hostname", catalogHasPageTitles, catalogTitles);
check(
  "catalog excerpts drop docs chrome",
  !/skip to content|documentation index|fetch the complete documentation/i.test(catalog.data?.summary ?? ""),
  catalog.data?.summary.slice(0, 220),
);

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

const emptyOther = await call<{ notes: { id: string }[] }>("/api/notes");
check("second visitor notebook is empty without a token", emptyOther.status === 200 && emptyOther.data?.notes.length === 0, emptyOther.data);

const otherSaved = await call<NoteSaveReply>("/api/notes", {
  method: "POST",
  body: { visitorId: other, title: "Other notebook", body: "This note belongs to the second visitor only.", turnstileToken: TOKEN },
});
if (noteId) {
  const cross = await call(`/api/notes/${noteId}`, { visitorToken: otherSaved.data?.visitorToken });
  check("another visitor cannot read the first visitor's note", cross.status === 404, cross.data);
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
