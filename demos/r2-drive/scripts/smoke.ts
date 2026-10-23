// Smoke against a running `bun run dev`. Usage: bun run scripts/smoke.ts [baseUrl]
import { TURNSTILE_DUMMY_TOKEN } from "../src/worker/turnstile";

const base = (process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8808").replace(/\/$/, "");
let failures = 0;

function check(label: string, ok: unknown, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

async function call(path: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { response, text, json };
}

const health = await call("/api/health");
check("health", health.response.ok && (health.json as { ok?: boolean })?.ok === true, health.text);
check("health is private", health.response.headers.get("cache-control")?.includes("no-store") === true);

const config = await call("/api/config");
check("config has aup", typeof (config.json as { aup?: string })?.aup === "string");

const noAup = await call("/api/mint", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "ada@example.com", turnstileToken: TURNSTILE_DUMMY_TOKEN }),
});
check("mint requires the notice", noAup.response.status === 400, noAup.text);

const disposable = await call("/api/mint", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "ada@mailinator.com", aup: true, turnstileToken: TURNSTILE_DUMMY_TOKEN }),
});
check("disposable rejected", disposable.response.status === 400, disposable.text);

const anon = await call("/dav/drv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/note.txt");
check("anonymous read rejected", anon.response.status === 401 && anon.text === "Unauthorized", anon.text);
check("anonymous read has no CORS", anon.response.headers.get("access-control-allow-origin") === null);
check("anonymous read is private", (anon.response.headers.get("cache-control") ?? "").includes("private, no-store"));

const minted = await call("/api/mint", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "ada@example.com", aup: true, turnstileToken: TURNSTILE_DUMMY_TOKEN }),
});
check("mint accepted", minted.response.ok, minted.text);
const outbox = await call("/api/dev/outbox");
const token = (outbox.json as { token?: string } | null)?.token;
check("dev outbox token", typeof token === "string" && token.length > 10, outbox.text);
const verified = await call("/api/verify", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token }),
});
const drive = verified.json as { driveId?: string; password?: string };
check("verify mints a drive", verified.response.ok && Boolean(drive.driveId && drive.password), verified.text);

if (drive.driveId && drive.password) {
  const auth = `Basic ${btoa(`${drive.driveId}:${drive.password}`)}`;
  const put = await call(`/dav/${drive.driveId}/note.txt`, {
    method: "PUT",
    headers: { authorization: auth, "content-type": "text/plain" },
    body: "hello from smoke",
  });
  check("put text", put.response.status === 201, put.text);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const rejected = await call(`/dav/${drive.driveId}/photo.png`, {
    method: "PUT",
    headers: { authorization: auth, "content-type": "text/plain" },
    body: png,
  });
  check("png rejected", rejected.response.status === 415, rejected.text);
  const open = await call(`/dav/${drive.driveId}/note.txt`);
  check("file stays private", open.response.status === 401 && !open.text.includes("hello"), open.text);
}

if (failures) {
  console.log(`${failures} smoke check(s) failed`);
  process.exit(1);
}
console.log("smoke ok");
