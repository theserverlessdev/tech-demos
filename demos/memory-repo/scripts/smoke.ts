// Smoke: bun run scripts/smoke.ts [baseUrl]
import { makeBlob } from "../src/worker/git";

const base = (process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const DUMMY = "XXXX.DUMMY.TOKEN.XXXX";

let failures = 0;
function check(label: string, ok: unknown, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

const blob = await makeBlob("hello\n");
check("blob hash matches git hash-object", blob.sha === "ce013625030ba8dba906f756967f9e9ca394464a", blob.sha);

let cookie = "";
async function call<T>(path: string, init: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}/api${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    const pair = setCookie.split(";")[0];
    if (pair) cookie = pair;
  }
  const text = await res.text();
  let data: (T & { error?: { code?: string; message?: string } }) | null = null;
  try {
    data = JSON.parse(text) as T & { error?: { code?: string; message?: string } };
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

console.log(`Target: ${base}`);
const health = await call<{ ok: boolean; d1: boolean; artifacts: string; turnstile: boolean }>("/health");
check("health reaches D1", health.status === 200 && health.data?.d1 === true, health.data);
check("turnstile secret is configured", health.data?.turnstile === true, health.data);
console.log(`artifacts binding: ${health.data?.artifacts ?? "unknown"}`);

const session = await call<{ siteKey: string | null; ready: boolean }>("/session");
check("session sets a visitor cookie", session.status === 200 && cookie.startsWith("mr_vid="), { cookie: Boolean(cookie), siteKey: session.data?.siteKey });

const rejected = await call("/repo", { method: "POST", body: {} });
check("missing turnstile token is rejected", rejected.status === 400 && rejected.data?.error?.code === "turnstile_required", rejected.data);

const created = await call<{ ready: boolean; repoName: string | null }>("/repo", { method: "POST", body: { turnstileToken: DUMMY } });
const createdOk = (created.status === 201 || created.status === 200) && created.data?.ready === true;
if (health.data?.artifacts === "ok") check("create opens an Artifacts repo", createdOk, created.data);
else check("local mirror opens a repo when Artifacts is down", createdOk, created.data);

const chat = await call<{ reply: string; committed: boolean; commitHash: string | null }>("/chat", {
  method: "POST",
  body: { message: "I prefer dark mode and short answers." },
});
check("chat can commit a preference", chat.status === 200 && chat.data?.committed === true && Boolean(chat.data.commitHash), chat.data);

if (chat.data?.commitHash) {
  const diff = await call<{ files: { path: string; patch: string }[] }>(`/commits/${chat.data.commitHash}`);
  check(
    "commit diff contains the preference",
    diff.status === 200 && (diff.data?.files ?? []).some((file) => file.path === "preferences.md" && file.patch.includes("dark mode")),
    diff.data?.files?.map((file) => file.path),
  );
}

const dream = await call<{ status: string; reason: string; steps: unknown[] }>("/dream", { method: "POST", body: {} });
check("dream returns steps and either a commit or a reason", dream.status === 200 && Array.isArray(dream.data?.steps) && (dream.data?.status === "committed" || dream.data?.status === "skipped"), dream.data);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nsmoke passed");
