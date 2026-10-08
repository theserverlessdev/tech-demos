// Smoke: bun run scripts/smoke.ts [baseUrl]
// Uses Cloudflare's published Turnstile dummy token. Prints no session or ingest secrets.
import type { AppConfig, ChatResult, CreatedOrg, MemoryItem, OrgView } from "../src/shared/types";

const base = (process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const DUMMY = "XXXX.DUMMY.TOKEN.XXXX";

let failures = 0;
function redact(detail: unknown): string {
  return JSON.stringify(detail).replace(/"(sessionToken|ingestToken)"\s*:\s*"[^"]*"/g, '"$1":"[redacted]"');
}
function check(label: string, ok: unknown, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${redact(detail)}` : ""}`);
  if (!ok) failures++;
}

async function call<T>(path: string, init: { method?: string; body?: unknown; session?: string; ingest?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.session) headers.authorization = `Bearer ${init.session}`;
  if (init.ingest) headers["x-ingest-token"] = init.ingest;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: { code: string; message: string } }) | null;
  return { status: res.status, data };
}

console.log(`Target: ${base}`);

const health = await call<{ ok: boolean; model: string }>("/api/health");
check("health is ok", health.status === 200 && health.data?.ok === true, health.data);

const config = await call<AppConfig>("/api/config");
check("config exposes a Turnstile site key", config.status === 200 && (config.data?.turnstileSiteKey.length ?? 0) > 10, config.data);

const noToken = await call("/api/orgs", { method: "POST", body: {} });
check("create without Turnstile is rejected", noToken.status === 400 || noToken.status === 403, noToken.data);

const createdA = await call<CreatedOrg>("/api/orgs", { method: "POST", body: { turnstileToken: DUMMY } });
const createdB = await call<CreatedOrg>("/api/orgs", { method: "POST", body: { turnstileToken: DUMMY } });
const a = createdA.data;
const b = createdB.data;
check("creates two orgs with distinct tokens", createdA.status === 201 && createdB.status === 201 && a?.id !== b?.id && a?.sessionToken !== b?.sessionToken && a?.ingestToken !== b?.ingestToken, {
  statusA: createdA.status,
  statusB: createdB.status,
});

if (!a?.id || !b?.id || !a.sessionToken || !b.sessionToken || !a.ingestToken || !b.ingestToken) {
  console.error("Cannot continue without two orgs.");
  process.exit(1);
}

check("seed includes the Thursday warehouse fact", a.facts.some((fact) => fact.text.includes("Thursdays")), a.facts.map((fact) => fact.id));
check("seed includes a refund decision", a.decisions.some((item) => item.text.includes("$200")));
check("create response does not include the hash columns", !("session_hash" in a) && !("ingest_hash" in a));

const bare = await call<OrgView>(`/api/orgs/${a.id}`);
check("read without a session is 401", bare.status === 401, bare.data);

const crossed = await call<OrgView>(`/api/orgs/${a.id}`, { session: b.sessionToken });
check("org B's session cannot read org A", crossed.status === 403, crossed.data);

const own = await call<OrgView>(`/api/orgs/${a.id}/memory`, { session: a.sessionToken });
check("org A's session can read its memory", own.status === 200 && (own.data?.facts.length ?? 0) >= 3, own.status);
check("a later read does not echo the ingest token", own.data ? !JSON.stringify(own.data).includes(a.ingestToken) : false);

const added = await call<{ item: MemoryItem }>(`/api/orgs/${a.id}/facts`, {
  method: "POST",
  session: a.sessionToken,
  body: { text: "The Austin warehouse closes early on the last Friday of the month.", author: "Ops", source: "smoke" },
});
check("manual fact is stored", added.status === 201 && added.data?.item.kind === "fact", added.status);

const other = await call<OrgView>(`/api/orgs/${b.id}`, { session: b.sessionToken });
check("org B does not see org A's new fact", other.status === 200 && !other.data?.facts.some((fact) => fact.text.includes("last Friday")), other.status);

const badIngest = await call(`/api/orgs/${a.id}/ingest`, {
  method: "POST",
  ingest: b.ingestToken,
  body: { kind: "decision", text: "This should not land in org A.", author: "Smoke", source: "smoke" },
});
check("org B's ingest token cannot write org A", badIngest.status === 403, badIngest.data);

const goodIngest = await call<{ item: MemoryItem }>(`/api/orgs/${a.id}/ingest`, {
  method: "POST",
  ingest: a.ingestToken,
  body: { kind: "decision", text: "Holiday shipping pauses on December 24 and 25.", author: "Ops", source: "webhook" },
});
check("org A's ingest token writes a decision", goodIngest.status === 201 && goodIngest.data?.item.kind === "decision", goodIngest.status);

const huge = await call(`/api/orgs/${a.id}/ingest`, {
  method: "POST",
  ingest: a.ingestToken,
  body: { kind: "fact", text: "x".repeat(2000), author: "Ops", source: "webhook" },
});
check("oversized ingest is rejected", huge.status === 400 || huge.status === 413, huge.status);

const noChatToken = await call(`/api/orgs/${a.id}/chat`, {
  method: "POST",
  session: a.sessionToken,
  body: { message: "When does the warehouse ship?" },
});
check("chat without Turnstile is rejected", noChatToken.status === 400 || noChatToken.status === 403, noChatToken.data);

const unknown = await call<ChatResult>(`/api/orgs/${a.id}/chat`, {
  method: "POST",
  session: a.sessionToken,
  body: { message: "What is the office wifi password?", turnstileToken: DUMMY },
});
check(
  "unrelated question is I don't know with no sources",
  unknown.status === 200 && unknown.data?.answer === "I don't know." && unknown.data.sources.length === 0,
  { status: unknown.status, answer: unknown.data?.answer, sources: unknown.data?.sources?.length },
);

const crossChat = await call(`/api/orgs/${a.id}/chat`, {
  method: "POST",
  session: b.sessionToken,
  body: { message: "When does the warehouse ship?", turnstileToken: DUMMY },
});
check("org B cannot chat as org A", crossChat.status === 403, crossChat.status);

const known = await call<ChatResult>(`/api/orgs/${a.id}/chat`, {
  method: "POST",
  session: a.sessionToken,
  body: { message: "When does the warehouse ship?", turnstileToken: DUMMY },
});
const cited = known.status === 200 && known.data?.sources.some((source) => source.kind === "fact" && source.snippet.includes("Thursday"));
const unavailable = known.status === 503 && known.data?.error?.code === "ai_unavailable";
check("shipping question cites the Thursday fact, or Workers AI is unavailable", Boolean(cited || unavailable), {
  status: known.status,
  answer: known.data?.answer?.slice(0, 140),
  sources: known.data?.sources?.map((source) => source.id),
  code: known.data?.error?.code,
});
if (cited) console.log(`      grounded: ${known.data?.answer.slice(0, 120)}`);
if (unavailable) console.log("      Workers AI binding did not answer; no guess was stored.");

const after = await call<OrgView>(`/api/orgs/${a.id}`, { session: a.sessionToken });
const leaked = after.data?.messages.some((message) => message.text.includes(a.ingestToken) || message.text.includes(a.sessionToken));
check("transcript does not contain tokens", after.status === 200 && !leaked);

const missing = await call(`/api/orgs/org_${"ab".repeat(16)}`, { session: a.sessionToken });
check("unknown org id is 404", missing.status === 404, missing.status);

const malformed = await call("/api/orgs/not-an-org");
check("malformed org id is 400", malformed.status === 400, malformed.status);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
