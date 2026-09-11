// Smoke test: AGENT_API_KEY=… bun run scripts/smoke.ts [baseUrl] [--smtp]
// --smtp posts raw MIME to wrangler dev's /cdn-cgi/handler/email, which runs the real email() handler. Local only.
import type { AppConfig, CreatedInbox, InboxInfo, MessageFull, MessageList, WaitResult } from "../src/shared/types";

const args = process.argv.slice(2);
const base = (args.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8797").replace(/\/$/, "");
const smtp = args.includes("--smtp");
const key = process.env.AGENT_API_KEY ?? (await Bun.file(new URL("../.dev.vars", import.meta.url)).text().catch(() => "")).match(/AGENT_API_KEY=(.+)/)?.[1]?.trim();
if (!key) throw new Error("Set AGENT_API_KEY, or put it in .dev.vars.");

let failures = 0;
function check(label: string, ok: unknown, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

async function call<T = unknown>(path: string, init: { method?: string; token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...init.headers };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}/api/v1${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });
  const data = (await res.json().catch(() => null)) as T & { error?: { code: string } };
  return { status: res.status, data };
}

function mime(to: string, subject: string, text: string): string {
  return [
    `From: "Smoke Test" <smoke@example.com>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${crypto.randomUUID()}@example.com>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
    "",
  ].join("\r\n");
}

console.log(`Target: ${base}`);

// ---------------------------------------------------------------- config
const config = await call<AppConfig>("/config");
check("config returns the mail domain", config.status === 200 && config.data.domain.includes("."), config);
const domain = config.data.domain;
console.log(`      MX live: ${config.data.mx.live} (${config.data.mx.records.join(", ") || "no MX records"})`);

// ---------------------------------------------------------------- web inbox and auth
const web = await call<CreatedInbox>("/inboxes", { method: "POST", body: {} });
check("web create returns 201 with a token", web.status === 201 && web.data.token.length > 30 && web.data.source === "web", web);
const inbox = web.data;
const path = `/inboxes/${encodeURIComponent(inbox.address)}`;

check("list without a token is 401", (await call(`${path}/messages`)).status === 401);
check("list with a wrong token is 404", (await call(`${path}/messages`, { token: "wrong-token-value" })).status === 404);
check("web caller cannot set ttlMinutes", (await call("/inboxes", { method: "POST", body: { ttlMinutes: 600 } })).status === 403);

const empty = await call<MessageList>(`${path}/messages`, { token: inbox.token });
check("new inbox has no messages", empty.status === 200 && empty.data.messages.length === 0, empty);

// ---------------------------------------------------------------- sample delivery
const sample = await call<MessageFull>(`${path}/sample`, { method: "POST", token: inbox.token });
check("sample returns 201", sample.status === 201, sample);
check("sample has html and text", !!sample.data.html && !!sample.data.text);
check("sample code is extracted", sample.data.codes.length === 1 && /^\d{6}$/.test(sample.data.codes[0]), sample.data.codes);
check("sample link is extracted", sample.data.links.some((l) => l.includes("verified=")), sample.data.links);
check("sample attachment metadata is kept", sample.data.attachments[0]?.filename === "signup-ticket.txt", sample.data.attachments);
check("sample sender is parsed", sample.data.from.name === "Ember Cloud", sample.data.from);

const listed = await call<MessageList>(`${path}/messages`, { token: inbox.token });
check("list shows the sample", listed.data.messages.length === 1 && listed.data.inbox.messageCount === 1, listed.data);
const after = await call<MessageList>(`${path}/messages?after=${listed.data.cursor}`, { token: inbox.token });
check("list after the cursor is empty", after.data.messages.length === 0, after.data);
check("web caller cannot deliver raw MIME", (await call(`${path}/deliver`, { method: "POST", token: inbox.token, raw: "x" })).status === 403);

const full = await call<MessageFull>(`${path}/messages/${sample.data.id}`, { token: inbox.token });
check("get message returns the body", full.status === 200 && full.data.html === sample.data.html);

const extended = await call<InboxInfo>(`${path}/extend`, { method: "POST", token: inbox.token, body: {} });
check("extend moves the expiry later", extended.status === 200 && extended.data.expiresAt > inbox.expiresAt, extended.data);

// ---------------------------------------------------------------- agent inbox
const name = `smoke-${Math.random().toString(36).slice(2, 8)}`;
const agent = await call<CreatedInbox>("/inboxes", { method: "POST", token: key, body: { localPart: name, ttlMinutes: 5 } });
check("agent create with a custom name", agent.status === 201 && agent.data.localPart === name && agent.data.source === "agent", agent);
check("agent TTL is 5 minutes", Math.abs(agent.data.expiresAt - agent.data.createdAt - 300_000) < 1000);
check("duplicate name is 409", (await call("/inboxes", { method: "POST", token: key, body: { localPart: name } })).status === 409);
check("reserved name is 400", (await call("/inboxes", { method: "POST", token: key, body: { localPart: "postmaster" } })).status === 400);
check("invalid name is 400", (await call("/inboxes", { method: "POST", token: key, body: { localPart: "-bad name-" } })).status === 400);
const agentPath = `/inboxes/${agent.data.address}`;
check("agent key opens a web inbox", (await call(`${path}/messages`, { token: key })).status === 200);

const idle = await call<WaitResult>(`${agentPath}/wait?after=0&timeout=2`, { token: key });
check("wait with no mail times out", idle.status === 200 && idle.data.timedOut && idle.data.messages.length === 0, idle.data);

const started = Date.now();
const waiting = call<WaitResult>(`${agentPath}/wait?after=0&timeout=20`, { token: key });
await Bun.sleep(1500);
const delivered = await call<MessageFull>(`${agentPath}/deliver`, {
  method: "POST",
  token: key,
  raw: mime(`${name}+signup@${domain}`, "Your login code", "Hi,\r\n\r\nYour one-time login code is 739104.\r\n\r\nhttps://example.com/confirm?t=abc."),
  headers: { "x-envelope-from": "bounce@example.com" },
});
check("agent deliver returns 201", delivered.status === 201, delivered);
const woke = await waiting;
const waitedMs = Date.now() - started;
check("wait returns the delivered message", woke.data.messages.length === 1 && !woke.data.timedOut, woke.data);
check("wait returns the code", woke.data.messages[0]?.codes.includes("739104"), woke.data.messages[0]?.codes);
check("text link loses its trailing dot", woke.data.messages[0]?.links[0] === "https://example.com/confirm?t=abc", woke.data.messages[0]?.links);
check("wait wakes within 4 s of delivery", waitedMs < 1500 + 4000, { waitedMs });
console.log(`      wait woke after ${waitedMs} ms (delivery at 1500 ms)`);

// ---------------------------------------------------------------- real email() handler (wrangler dev only)
if (smtp) {
  const to = `${name}@${domain}`;
  const res = await fetch(`${base}/cdn-cgi/handler/email?from=${encodeURIComponent("sender@example.org")}&to=${encodeURIComponent(to)}`, {
    method: "POST",
    body: mime(to, "Through email()", "Confirm with code 551177"),
  });
  console.log(`      email handler response: ${res.status} ${(await res.text()).slice(0, 120)}`);
  const viaSmtp = await call<WaitResult>(`${agentPath}/wait?after=${woke.data.cursor}&timeout=5`, { token: key });
  const m = viaSmtp.data.messages[0];
  check("email() stores the message with via=smtp", m?.via === "smtp" && m.envelopeFrom === "sender@example.org", m);
  check("email() message code is extracted", m?.codes.includes("551177"), m?.codes);

  const unknown = await fetch(`${base}/cdn-cgi/handler/email?from=a@example.org&to=${encodeURIComponent(`nobody-here-${Date.now()}@${domain}`)}`, {
    method: "POST",
    body: mime("nobody@x", "x", "x"),
  });
  const unknownBody = await unknown.text();
  console.log(`      unknown recipient response: ${unknown.status} ${unknownBody.slice(0, 160)}`);
  check("email() rejects an unknown recipient", /reject|No active inbox/i.test(unknownBody) || unknown.status >= 400, unknownBody);
}

// ---------------------------------------------------------------- deletes
check("delete message", (await call(`${path}/messages/${sample.data.id}`, { method: "DELETE", token: inbox.token })).status === 200);
check("deleted message is 404", (await call(`${path}/messages/${sample.data.id}`, { token: inbox.token })).status === 404);
check("delete web inbox", (await call(path, { method: "DELETE", token: inbox.token })).status === 200);
check("deleted inbox is 404", (await call(`${path}/messages`, { token: inbox.token })).status === 404);
check("delete agent inbox", (await call(agentPath, { method: "DELETE", token: key })).status === 200);

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
