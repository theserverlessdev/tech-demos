// bun run scripts/smoke.ts [baseUrl]
import { KEY_HEADER } from "../src/shared/limits";

const base = (process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const prefix = base.includes("/demos/byok-playground") ? "" : "/demos/byok-playground";
const root = `${base}${prefix}`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const health = await fetch(`${root}/api/health`);
if (!health.ok) fail(`health ${health.status}`);

const page = await fetch(`${root}/`);
const setCookie = page.headers.get("set-cookie") ?? "";
if (!setCookie.includes("byok_session=")) fail("page did not mint a session cookie");
const cookie = setCookie.split(";")[0]!;

const blocked = await fetch(`${root}/api/proxy/models`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://evil.example", cookie, [KEY_HEADER]: "sk-test" },
  body: JSON.stringify({ baseUrl: "https://api.openai.com/v1" }),
});
if (blocked.status !== 403) fail(`expected origin 403, got ${blocked.status}`);

const ssrf = await fetch(`${root}/api/proxy/models`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: root.startsWith("http://127") ? root : "http://127.0.0.1:8787", cookie, [KEY_HEADER]: "sk-test" },
  body: JSON.stringify({ baseUrl: "http://169.254.169.254/" }),
});
const ssrfBody = await ssrf.text();
if (ssrf.ok) fail("metadata URL should be blocked");
if (ssrfBody.includes("sk-test")) fail("key leaked in SSRF error");

const nosession = await fetch(`${root}/api/proxy/models`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: "http://127.0.0.1:8787", [KEY_HEADER]: "sk-test" },
  body: JSON.stringify({ baseUrl: "https://api.openai.com/v1" }),
});
if (nosession.status !== 401) fail(`expected session 401, got ${nosession.status}`);

console.log("smoke ok", { health: health.status, origin: blocked.status, ssrf: ssrf.status, session: nosession.status });
