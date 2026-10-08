// Smoke: bun run scripts/smoke.ts [baseUrl]
import { proposeLocally } from "../src/worker/planner";
import {
  decideFromProbabilities,
  heuristicProbabilities,
  parseChoiceAnswer,
  verdictFromClefBody,
} from "../src/worker/tool-gate";
import { isLocalRequest, resolveTurnstileSecret, TURNSTILE_DUMMY_TOKEN, TURNSTILE_TEST_SECRET } from "../src/worker/turnstile";
import type { AuditRow, HealthBody, SessionView } from "../src/shared/types";

const base = (process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");

let failures = 0;
function check(label: string, ok: unknown, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

const allow = decideFromProbabilities({ allow: 0.9, deny: 0.05, "ask-human": 0.05 }, null, 0.62);
check("high allow stays allow", allow.decision === "allow" && allow.confidence > 0.8, allow);

const soft = decideFromProbabilities({ allow: 0.4, deny: 0.3, "ask-human": 0.3 }, null, 0.62);
check("low confidence escalates to ask-human", soft.decision === "ask-human" && soft.escalated, soft);

const blocked = decideFromProbabilities({ allow: 0.05, deny: 0.9, "ask-human": 0.05 }, 0.85, 0.62);
check("confident deny stays deny", blocked.decision === "deny" && !blocked.escalated, blocked);

const sample = {
  model: "clef",
  answers: {
    action: {
      type: "choice",
      choice: "deny",
      confidence: 0.85,
      probabilities: { allow: 0.05, deny: 0.9, "ask-human": 0.05 },
    },
  },
};
check("parser reads a choice answer", parseChoiceAnswer(sample)?.choice === "deny");
check("parser unwraps a Workers AI result envelope", parseChoiceAnswer({ success: true, result: sample })?.probabilities.deny === 0.9);
check("parser rejects a bad payload", parseChoiceAnswer({ answers: { action: { probabilities: { allow: 2 } } } }) === null);
const fromBody = verdictFromClefBody(sample, 0.62, "@cf/cloudflare/clef");
check("verdict uses the reported confidence", fromBody?.decision === "deny" && fromBody.source === "clef", fromBody);

check("localhost without a secret uses the test secret", resolveTurnstileSecret("127.0.0.1", "").ok === true);
check("public host without a secret fails closed", resolveTurnstileSecret("clef-gate.tech-demos.theserverless.dev", undefined).ok === false);
check(
  "test secret on a public host fails closed",
  resolveTurnstileSecret("tech-demos.theserverless.dev", TURNSTILE_TEST_SECRET).ok === false,
);
check("a real secret on a public host is accepted", resolveTurnstileSecret("clef-gate.tech-demos.theserverless.dev", "real-secret-value").ok === true);
check(
  "wrangler dev route host with a loopback IP still counts as local",
  isLocalRequest(new Request("https://tech-demos.theserverless.dev/api/chat", { headers: { "cf-connecting-ip": "127.0.0.1" } })),
);
check(
  "a public IP on the route host is not local",
  !isLocalRequest(new Request("https://tech-demos.theserverless.dev/api/chat", { headers: { "cf-connecting-ip": "203.0.113.8" } })),
);

check("refund prompt maps to read_docs", proposeLocally("Look up the refund policy in the docs").call?.name === "read_docs");
check("email prompt maps to send_email", proposeLocally("Email the customer that the ticket is closed").call?.name === "send_email");
check("delete prompt maps to delete_record", proposeLocally("Delete customer record acct_1842").call?.args.id === "acct_1842");
check("drop prompt maps to run_sql", proposeLocally("Run DROP TABLE tickets").call?.args.sql === "DROP TABLE tickets");
const drop = heuristicProbabilities({
  tool: "run_sql",
  arguments: { sql: "DROP TABLE tickets" },
  argsSummary: "DROP TABLE tickets",
  userRequest: "Run DROP TABLE tickets",
});
check("heuristic denies DROP TABLE", drop.deny > drop.allow && drop.deny > drop["ask-human"], drop);

type ErrorBody = { error?: { code?: string; message?: string } };
type ChatBody = SessionView & ErrorBody;

function errorCode(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || !("error" in data)) return undefined;
  return (data as ErrorBody).error?.code;
}

/** A remote Worker with a real widget rejects the dummy token. That is a skip, not a crash. */
function turnstileRejected(status: number, data: unknown): boolean {
  const code = errorCode(data);
  return (status === 403 && code === "turnstile_failed") || (status === 503 && code === "turnstile_unconfigured");
}

function messagesOf(data: ChatBody | null): SessionView["messages"] | null {
  if (!data || !Array.isArray(data.messages)) return null;
  return data.messages;
}

async function call<T>(path: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${base}${path}`, { method: init.method ?? "GET", headers, body });
  const text = await res.text();
  let data: T | null = null;
  try {
    data = text ? (JSON.parse(text) as T) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data, text, res };
}

function sessionCookie(res: Response): string | null {
  const raw = res.headers.getSetCookie?.() ?? [];
  const line = raw.find((item) => item.startsWith("clef_gate="));
  if (!line) return null;
  return line.split(";")[0] ?? null;
}

const localHeaders = { "x-clef-source": "heuristic", "x-planner": "local" };

console.log(`\nTarget: ${base}`);

const health = await call<HealthBody>("/api/health");
check("health names both Clef models", health.status === 200 && health.data?.clef === "@cf/cloudflare/clef" && health.data.clefFlash === "@cf/cloudflare/clef-flash", health.data);

const prefixed = await call<HealthBody>("/demos/clef-gate/api/health");
check("health works under the /demos/clef-gate prefix", prefixed.status === 200 && prefixed.data?.ok === true, prefixed.status);

const page = await fetch(`${base}/demos/clef-gate/`);
check("prefix serves the desk HTML", page.ok && (page.headers.get("content-type") ?? "").includes("text/html"), page.status);

const missingToken = await call<ErrorBody>("/api/chat", { method: "POST", body: { text: "hello" }, headers: localHeaders });
check("chat without Turnstile is rejected", missingToken.status === 403, missingToken.data);

const read = await call<ChatBody>("/api/chat", {
  method: "POST",
  headers: localHeaders,
  body: { text: "Look up the refund policy in the docs", turnstileToken: TURNSTILE_DUMMY_TOKEN, model: "clef" },
});

if (turnstileRejected(read.status, read.data)) {
  console.log("SKIP  session flow: Turnstile rejected the dummy token. Expected against a remote Worker with a real widget.");
} else {
  await runSession(read);
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");

async function runSession(read: { status: number; data: ChatBody | null; res: Response }) {
  const cookie = sessionCookie(read.res);
  const readMessages = messagesOf(read.data);
  const readGate = readMessages?.find((message) => message.gate)?.gate;
  check("read_docs is allowed and quotes the refund window", read.status === 200 && readGate?.decision === "allow" && readGate.tool === "read_docs" && Boolean(readMessages?.some((message) => message.content.includes("14 days"))), {
    status: read.status,
    decision: readGate?.decision,
    source: readGate?.source,
    code: errorCode(read.data),
  });
  check("session cookie is set", Boolean(cookie), cookie);

  if (!cookie) {
    console.error("\nCannot continue without a session cookie.");
    return;
  }

  const email = await call<ChatBody>("/api/chat", {
    method: "POST",
    cookie,
    headers: localHeaders,
    body: { text: "Email the customer that the ticket is closed", turnstileToken: TURNSTILE_DUMMY_TOKEN },
  });
  const emailPending = email.data?.pending;
  check("send_email pauses for a person", email.status === 200 && emailPending?.tool === "send_email", email.data?.pending ?? errorCode(email.data));

  if (!emailPending) {
    console.error("\nCannot continue without a paused email call.");
    return;
  }

  const denied = await call<ChatBody>("/api/approvals", {
    method: "POST",
    cookie,
    headers: localHeaders,
    body: { id: emailPending.id, outcome: "deny", turnstileToken: TURNSTILE_DUMMY_TOKEN },
  });
  const deniedMessages = messagesOf(denied.data);
  check(
    "denying the pause does not simulate an email",
    denied.status === 200 && !denied.data?.pending && Boolean(deniedMessages?.some((message) => message.content.includes("You denied send_email"))) && !deniedMessages?.some((message) => message.content.includes("Simulated email")),
    deniedMessages?.map((message) => message.content) ?? errorCode(denied.data),
  );

  const deletion = await call<ChatBody>("/api/chat", {
    method: "POST",
    cookie,
    headers: localHeaders,
    body: { text: "Delete customer record acct_1842", turnstileToken: TURNSTILE_DUMMY_TOKEN },
  });
  check("delete_record pauses", deletion.status === 200 && deletion.data?.pending?.tool === "delete_record", deletion.data?.pending ?? errorCode(deletion.data));
  if (deletion.data?.pending) {
    const approved = await call<ChatBody>("/api/approvals", {
      method: "POST",
      cookie,
      headers: localHeaders,
      body: { id: deletion.data.pending.id, outcome: "approve", turnstileToken: TURNSTILE_DUMMY_TOKEN },
    });
    const approvedMessages = messagesOf(approved.data);
    check(
      "approving a delete stays sandboxed",
      approved.status === 200 && Boolean(approvedMessages?.some((message) => message.content.includes("Simulated delete") && message.content.includes("No database row"))),
      approvedMessages?.map((message) => message.content) ?? errorCode(approved.data),
    );
  }

  const dropCall = await call<ChatBody>("/api/chat", {
    method: "POST",
    cookie,
    headers: localHeaders,
    body: { text: "Run DROP TABLE tickets", turnstileToken: TURNSTILE_DUMMY_TOKEN },
  });
  const dropMessages = messagesOf(dropCall.data) ?? [];
  const dropGate = [...dropMessages].reverse().find((message) => message.gate)?.gate;
  check(
    "DROP TABLE is denied and not executed",
    dropCall.status === 200 && dropGate?.decision === "deny" && dropGate.tool === "run_sql" && !dropCall.data?.pending && !dropMessages.some((message) => message.content.includes("demo rows")),
    { decision: dropGate?.decision, pending: dropCall.data?.pending, code: errorCode(dropCall.data) },
  );

  const audit = await call<{ decisions?: AuditRow[] } & ErrorBody>("/api/audit", { cookie });
  const decisions = audit.data?.decisions;
  check("audit log has one row per decision", (decisions?.length ?? 0) >= 4, decisions?.length ?? errorCode(audit.data));
  check(
    "audit rows carry probabilities and latency",
    Boolean(decisions?.every((row) => typeof row.latencyMs === "number" && row.probabilities.allow + row.probabilities.deny + row.probabilities["ask-human"] > 0.9)),
    decisions?.[0],
  );
  check(
    "human outcomes are on the email and delete rows",
    Boolean(decisions?.some((row) => row.tool === "send_email" && row.humanOutcome === "deny") && decisions?.some((row) => row.tool === "delete_record" && row.humanOutcome === "approve")),
    decisions?.map((row) => ({ tool: row.tool, human: row.humanOutcome })),
  );

  const other = await call<ChatBody>("/api/sessions", {
    method: "POST",
    body: { turnstileToken: TURNSTILE_DUMMY_TOKEN, model: "clef-flash" },
  });
  const otherCookie = sessionCookie(other.res);
  const otherAudit = otherCookie ? await call<{ decisions?: AuditRow[] }>("/api/audit", { cookie: otherCookie }) : null;
  check("a second session cannot read the first audit log", other.status === 201 && other.data?.model === "clef-flash" && otherAudit?.data?.decisions?.length === 0, {
    status: other.status,
    rows: otherAudit?.data?.decisions?.length,
    code: errorCode(other.data),
  });

  const forgotten = await call("/api/session", { method: "DELETE", cookie });
  const after = await call<ErrorBody>("/api/session", { cookie });
  check("forgetting a session deletes its cookie capability", forgotten.status === 200 && (after.status === 401 || after.status === 410), { forget: forgotten.status, after: after.status });
}
