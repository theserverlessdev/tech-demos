// Smoke: bun run scripts/smoke.ts [baseUrl]
import type { DraftResult, Health, TicketDetail, TicketSummary } from "../src/shared/types";

const base = (process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const origin = base;
const DUMMY = "XXXX.DUMMY.TOKEN.XXXX";

let failures = 0;
function check(label: string, ok: unknown, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

async function call<T>(path: string, init: { method?: string; body?: unknown; form?: FormData; cookie?: string; origin?: string } = {}) {
  const headers: Record<string, string> = { origin: init.origin ?? origin, "sec-fetch-site": "same-origin" };
  if (init.cookie) headers.cookie = init.cookie;
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${base}/api${path}`, { method: init.method ?? "GET", headers, body });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const text = await res.text();
  let data: T | null = null;
  try {
    data = JSON.parse(text) as T;
  } catch {
    data = null;
  }
  return { status: res.status, data, text, res, setCookie };
}

console.log(`Target: ${base}`);

const health = await call<Health>("/health");
check("health is ok with seeded tickets", health.status === 200 && health.data?.ok && (health.data.tickets ?? 0) >= 5, health.data);
check("health mailMode is queue (capture analog, no Email Routing)", health.data?.mailMode === "queue", health.data);
check("health exposes session + budget", Boolean(health.data?.session && health.data.budget), health.data);

const blocked = await call("/inbound", { method: "POST", body: { turnstileToken: DUMMY }, origin: "https://evil.example" });
check("cross-origin inbound is rejected", blocked.status === 403, blocked.status);

const minted = await call<{ ok: boolean }>("/session", { method: "POST", body: { turnstileToken: DUMMY } });
const cookie = minted.setCookie.split(";")[0] ?? "";
check("session mint sets rhq_session", minted.status === 200 && cookie.startsWith("rhq_session="), { status: minted.status, cookie });
if (!cookie.startsWith("rhq_session=")) {
  console.error("Cannot continue without a session cookie.");
  process.exit(1);
}

const nosession = await call<{ tickets: TicketSummary[] }>("/tickets");
check("ticket list requires a session", nosession.status === 401, nosession.status);

const list = await call<{ tickets: TicketSummary[] }>("/tickets", { cookie });
check("lists at least 5 tickets", list.status === 200 && (list.data?.tickets.length ?? 0) >= 5, list.data?.tickets.length);
const billing = list.data?.tickets.find((t) => t.number === 1042);
check("seed ticket 1042 exists", Boolean(billing), billing?.subject);
check("list subjects stay short", (list.data?.tickets.every((t) => t.subject.length <= 200) ?? false), list.data?.tickets.map((t) => t.subject.length));

if (!billing) {
  console.error("Cannot continue without the seed ticket.");
  process.exit(1);
}

const badId = await fetch(`${base}/api/tickets/%E0%A4%A`, { headers: { origin, cookie } });
check("malformed ticket id is 404 not 500", badId.status === 404, badId.status);

const detail = await call<TicketDetail>(`/tickets/${billing.id}`, { cookie });
check("ticket 1042 has a thread and a seed attachment", Boolean(detail.data && detail.data.messages.length >= 2 && detail.data.attachments.length >= 1), {
  messages: detail.data?.messages.length,
  attachments: detail.data?.attachments.length,
});

const att = detail.data?.attachments[0];
if (att) {
  const file = await fetch(`${base}/api/tickets/${billing.id}/attachments/${att.id}`, { headers: { origin, cookie } });
  const body = await file.text();
  check("seed attachment downloads from R2", file.ok && body.includes("INV-8841"), { status: file.status, bytes: body.length });
  check("seed attachment is nosniff + attachment", file.headers.get("x-content-type-options") === "nosniff" && (file.headers.get("content-disposition") ?? "").includes("attachment"), {
    nosniff: file.headers.get("x-content-type-options"),
    disposition: file.headers.get("content-disposition"),
    csp: file.headers.get("content-security-policy"),
    corp: file.headers.get("cross-origin-resource-policy"),
  });
}

const js = new Blob(["document.title='gadget'"], { type: "text/javascript" });
const jsForm = new FormData();
jsForm.set("file", js, "gadget.js");
jsForm.set("turnstileToken", DUMMY);
const rejectedJs = await call(`/tickets/${billing.id}/attachments`, { method: "POST", form: jsForm, cookie });
check("javascript upload is rejected", rejectedJs.status === 415, rejectedJs.status);

const blob = new Blob(["smoke attachment from resolve-hq\n"], { type: "text/plain" });
const form = new FormData();
form.set("file", blob, "smoke.txt");
form.set("turnstileToken", DUMMY);
const uploaded = await call<AttachmentLike>(`/tickets/${billing.id}/attachments`, { method: "POST", form, cookie });
check("upload stores a file", uploaded.status === 201 && uploaded.data?.filename === "smoke.txt", uploaded.data);

if (uploaded.data) {
  const round = await fetch(`${base}/api/tickets/${billing.id}/attachments/${uploaded.data.id}`, { headers: { origin, cookie } });
  check("uploaded file round-trips from R2", round.ok && (await round.text()).includes("smoke attachment"), { status: round.status });
  check("uploaded file is forced attachment", (round.headers.get("content-disposition") ?? "").startsWith("attachment"), round.headers.get("content-disposition"));
}

const before = list.data?.tickets.map((t) => t.id) ?? [];
const inbound = await call<{ queued: boolean; ticketId: string }>("/inbound", {
  method: "POST",
  cookie,
  body: {
    fromName: "Smoke Bot",
    fromEmail: "smoke@example.com",
    subject: "Smoke inbound: queue consumer should open a ticket",
    body: "This message was enqueued by scripts/smoke.ts. The consumer should insert a D1 ticket.",
    turnstileToken: DUMMY,
  },
});
check("inbound enqueue returns 202 with ticketId", inbound.status === 202 && inbound.data?.queued === true && Boolean(inbound.data.ticketId), inbound);

const blank = await call("/inbound", { method: "POST", cookie, body: { fromEmail: "   ", body: "   ", turnstileToken: DUMMY } });
check("blank inbound is 400 not 202", blank.status === 400, blank.status);

let created: TicketSummary | undefined;
for (let i = 0; i < 15; i++) {
  await Bun.sleep(800);
  const again = await call<{ tickets: TicketSummary[] }>("/tickets", { cookie });
  created = again.data?.tickets.find((t) => t.id === inbound.data?.ticketId || (!before.includes(t.id) && t.lastVia === "queue"));
  if (created) break;
}
check("queue consumer created a visitor-sandbox ticket", Boolean(created && created.sandbox && created.subject.includes("Smoke inbound")), created);

const follow = created ?? billing;
const draft = await call<DraftResult>(`/tickets/${follow.id}/draft`, { method: "POST", cookie, body: { turnstileToken: DUMMY } });
const draftOk = draft.status === 200 && typeof draft.data?.draft === "string" && draft.data.draft.length > 20;
check("draft reply returns text", draftOk, { status: draft.status, source: draft.data?.source, preview: draft.data?.draft?.slice(0, 80) });
if (draftOk) {
  console.log(`      source=${draft.data?.source}  model=${draft.data?.model}  ${draft.data?.draft.slice(0, 80)}…`);
  if (draft.data?.source === "fallback") {
    console.warn("WARN  draft used the stub path. Run `bun run dev:ai` (wrangler login) for a Workers AI screenshot.");
  }
}

const deep = await fetch(`${base}/tickets/1042`);
check("unknown deep link redirects to the app root", deep.status === 302 || deep.redirected || deep.url.replace(/\/$/, "") === base, { status: deep.status, url: deep.url });

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");

type AttachmentLike = { id: string; filename: string };
