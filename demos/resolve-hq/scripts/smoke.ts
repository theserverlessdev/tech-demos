// Smoke: bun run scripts/smoke.ts [baseUrl]
import type { DraftResult, TicketDetail, TicketSummary } from "../src/shared/types";

const base = (process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");

let failures = 0;
function check(label: string, ok: unknown, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

async function call<T>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}) {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.body !== undefined) {
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
  return { status: res.status, data, text, res };
}

console.log(`Target: ${base}`);

const health = await call<{ ok: boolean; tickets: number }>("/health");
check("health is ok with seeded tickets", health.status === 200 && health.data?.ok && (health.data.tickets ?? 0) >= 5, health.data);

const list = await call<{ tickets: TicketSummary[] }>("/tickets");
check("lists at least 5 tickets", list.status === 200 && (list.data?.tickets.length ?? 0) >= 5, list.data?.tickets.length);
const billing = list.data?.tickets.find((t) => t.number === 1042);
check("seed ticket 1042 exists", Boolean(billing), billing?.subject);

if (!billing) {
  console.error("Cannot continue without the seed ticket.");
  process.exit(1);
}

const detail = await call<TicketDetail>(`/tickets/${billing.id}`);
check("ticket 1042 has a thread and a seed attachment", Boolean(detail.data && detail.data.messages.length >= 2 && detail.data.attachments.length >= 1), {
  messages: detail.data?.messages.length,
  attachments: detail.data?.attachments.length,
});

const att = detail.data?.attachments[0];
if (att) {
  const file = await fetch(`${base}/api/tickets/${billing.id}/attachments/${att.id}`);
  const body = await file.text();
  check("seed attachment downloads from R2", file.ok && body.includes("INV-8841"), { status: file.status, bytes: body.length });
}

const blob = new Blob(["smoke attachment from resolve-hq\n"], { type: "text/plain" });
const form = new FormData();
form.set("file", blob, "smoke.txt");
const uploaded = await call<AttachmentLike>(`/tickets/${billing.id}/attachments`, { method: "POST", form });
check("upload stores a file", uploaded.status === 201 && uploaded.data?.filename === "smoke.txt", uploaded.data);

if (uploaded.data) {
  const round = await fetch(`${base}/api/tickets/${billing.id}/attachments/${uploaded.data.id}`);
  check("uploaded file round-trips from R2", round.ok && (await round.text()).includes("smoke attachment"), { status: round.status });
}

const before = list.data?.tickets.map((t) => t.id) ?? [];
const inbound = await call<{ queued: boolean }>("/inbound", {
  method: "POST",
  body: {
    fromName: "Smoke Bot",
    fromEmail: "smoke@example.com",
    subject: "Smoke inbound: queue consumer should open a ticket",
    body: "This message was enqueued by scripts/smoke.ts. The consumer should insert a D1 ticket.",
  },
});
check("inbound enqueue returns 202", inbound.status === 202 && inbound.data?.queued === true, inbound);

let created: TicketSummary | undefined;
for (let i = 0; i < 15; i++) {
  await Bun.sleep(800);
  const again = await call<{ tickets: TicketSummary[] }>("/tickets");
  created = again.data?.tickets.find((t) => !before.includes(t.id) && t.lastVia === "queue");
  if (created) break;
}
check("queue consumer created a visible ticket", Boolean(created && created.subject.includes("Smoke inbound")), created);

const follow = created ?? billing;
const draft = await call<DraftResult>(`/tickets/${follow.id}/draft`, { method: "POST" });
const draftOk = draft.status === 200 && typeof draft.data?.draft === "string" && draft.data.draft.length > 20;
const draftSoft = draft.status === 503;
check("draft reply returns text, or fails soft with 503", draftOk || draftSoft, { status: draft.status, preview: draft.data });
if (draftOk) console.log(`      draft ${draft.data?.draft.slice(0, 80)}…`);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");

type AttachmentLike = { id: string; filename: string };
