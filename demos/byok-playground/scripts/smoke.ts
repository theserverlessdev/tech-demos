// bun run scripts/smoke.ts [baseUrl]
const base = (process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const origin = new URL(base).origin;
const root = base;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const health = await fetch(`${root}/api/health`);
if (!health.ok) fail(`health ${health.status}`);

const page = await fetch(`${root}/`);
if (!page.ok) fail(`page ${page.status}`);

const minted = await fetch(`${root}/api/session`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" }),
});
if (!minted.ok) fail(`session mint ${minted.status} ${await minted.text()}`);
const setCookie = minted.headers.get("set-cookie") ?? "";
if (!setCookie.includes("byok_session=")) fail("session mint did not set a signed cookie");
const cookie = setCookie.split(";")[0]!;

const blocked = await fetch(`${root}/api/proxy/models`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://evil.example", cookie },
  body: JSON.stringify({ apiKey: "sk-test", baseUrl: "https://api.openai.com/v1" }),
});
if (blocked.status !== 403) fail(`expected origin 403, got ${blocked.status}`);

const ssrf = await fetch(`${root}/api/proxy/models`, {
  method: "POST",
  headers: { "content-type": "application/json", origin, cookie },
  body: JSON.stringify({ apiKey: "sk-test", baseUrl: "http://169.254.169.254/" }),
});
const ssrfBody = await ssrf.text();
if (ssrf.ok) fail("metadata URL should be blocked");
if (!ssrfBody.includes("ssrf") && !ssrfBody.includes("blocked") && !ssrfBody.includes("https") && !ssrfBody.includes("IP")) {
  fail(`expected SSRF error, got ${ssrfBody}`);
}
if (ssrfBody.includes("sk-test")) fail("key leaked in SSRF error");

const mock = await fetch(`${root}/api/proxy/models`, {
  method: "POST",
  headers: { "content-type": "application/json", origin, cookie },
  body: JSON.stringify({ apiKey: "sk-mock-local-key", baseUrl: "http://127.0.0.1:8799/v1" }),
});
const mockBody = await mock.text();
if (!mock.ok) fail(`mock models failed ${mock.status} ${mockBody}`);
if (mockBody.includes("sk-mock-local-key")) fail("key leaked in models response");
if (!mockBody.includes("mock-gpt")) fail(`expected mock models, got ${mockBody}`);
const models = JSON.parse(mockBody) as { data?: { id?: string; object?: string }[] };
if (models.data?.some((row) => row.object)) fail("models response leaked extra fields");

const nosession = await fetch(`${root}/api/proxy/models`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ apiKey: "sk-test", baseUrl: "https://api.openai.com/v1" }),
});
if (nosession.status !== 401) fail(`expected session 401, got ${nosession.status}`);

console.log("smoke ok", { health: health.status, origin: blocked.status, ssrf: ssrf.status, mock: mock.status, session: nosession.status });
