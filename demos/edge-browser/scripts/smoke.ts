// Smoke: bun run scripts/smoke.ts [baseUrl]
const base = (process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8791").replace(/\/$/, "");
const DUMMY = "XXXX.DUMMY.TOKEN.XXXX";

let failures = 0;
function check(label: string, ok: unknown, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

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
  return { status: res.status, data, bytes: text };
}

console.log(`Target: ${base}`);
const health = await call<{ ok: boolean; d1: boolean; turnstile: boolean; browser: string }>("/health");
check("health reaches D1", health.status === 200 && health.data?.d1 === true, health.data);
check("turnstile secret is configured", health.data?.turnstile === true, health.data);
check("local mode reports the browser stand-in", health.data?.browser === "stub", health.data);

const session = await call<{ siteKey: string | null }>("/session");
check("session sets a visitor cookie", session.status === 200 && cookie.startsWith("eb_vid="), { cookie: Boolean(cookie), siteKey: session.data?.siteKey });

const missing = await call("/captures", { method: "POST", body: { url: "https://example.com" } });
check("missing turnstile token is rejected", missing.status === 400 && missing.data?.error?.code === "turnstile_required", missing.data);

for (const url of ["http://127.0.0.1/", "http://2130706433/", "http://0x7f000001/", "http://[::ffff:127.0.0.1]/", "http://169.254.169.254/", "file:///etc/passwd", "http://localhost/admin"]) {
  const rejected = await call("/captures", { method: "POST", body: { url, turnstileToken: DUMMY } });
  check(`rejects ${url}`, rejected.status === 400, rejected.data);
}

const created = await call<{ id: string }>("/captures", { method: "POST", body: { url: "https://example.com", turnstileToken: DUMMY } });
check("capture starts", created.status === 201 && typeof created.data?.id === "string", created.data);
const id = created.data?.id ?? "";

let view: { status?: string; browserMode?: string; markdown?: string | null; summary?: string | null; hasDesktop?: boolean; error?: string | null } | null = null;
if (id) {
  for (let i = 0; i < 40; i++) {
    const polled = await call<typeof view>(`/captures/${id}`);
    view = polled.data;
    if (view?.status === "complete" || view?.status === "error") break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
check("stub flow finishes", view?.status === "complete" && view.browserMode === "stub", view);
check("markdown is the local stand-in", Boolean(view?.markdown?.includes("Local stand-in")), view?.markdown?.slice(0, 120));
check("summary is present", Boolean(view?.summary && view.summary.length > 10), view?.summary?.slice(0, 120));

if (id && view?.hasDesktop) {
  const image = await fetch(`${base}/api/captures/${id}/desktop`, { headers: cookie ? { cookie } : {} });
  const bytes = new Uint8Array(await image.arrayBuffer());
  check("desktop preview is a png", image.status === 200 && bytes[0] === 137 && bytes[1] === 80, { status: image.status, len: bytes.length });
}

const listed = await call<{ captures: { id: string }[] }>("/captures");
check("gallery lists this capture", (listed.data?.captures ?? []).some((item) => item.id === id), listed.data);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nsmoke passed");
