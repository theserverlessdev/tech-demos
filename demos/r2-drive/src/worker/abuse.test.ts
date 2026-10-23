import { expect, test } from "bun:test";
import { DAILY_MINT_CAP } from "../shared/constants";
import { createTestApp, davUrl, mintDrive } from "./test-app";

const ORIGIN = "http://127.0.0.1:8808";

async function post(app: Awaited<ReturnType<typeof createTestApp>>, path: string, body: unknown, headers?: HeadersInit) {
  return app.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
    body: JSON.stringify(body),
  });
}

test("put checks magic bytes and ignores the extension and content type", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app);
  const auth = { authorization: `Basic ${btoa(`${minted.driveId}:${minted.password}`)}` };
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const image = await app.fetch(davUrl(minted.driveId, "notes.txt"), {
    method: "PUT",
    headers: { ...auth, "content-type": "text/plain" },
    body: png,
  });
  expect(image.status).toBe(415);
  const text = await app.fetch(davUrl(minted.driveId, "photo.png"), {
    method: "PUT",
    headers: { ...auth, "content-type": "image/png" },
    body: "not an image\n",
  });
  expect(text.status).toBe(201);
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  expect((await app.fetch(davUrl(minted.driveId, "bundle.docx"), { method: "PUT", headers: auth, body: zip })).status).toBe(415);
  const read = await app.fetch(davUrl(minted.driveId, "photo.png"), { headers: auth });
  expect(read.headers.get("cache-control")).toBe("private, no-store");
  expect(read.headers.get("access-control-allow-origin")).toBeNull();
});

test("files are unreadable without the owner credential", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app);
  const auth = { authorization: `Basic ${btoa(`${minted.driveId}:${minted.password}`)}` };
  expect((await app.fetch(davUrl(minted.driveId, "note.txt"), { method: "PUT", headers: auth, body: "secret note" })).status).toBe(201);
  const anon = await app.fetch(davUrl(minted.driveId, "note.txt"), { headers: { origin: "https://evil.example" } });
  expect(anon.status).toBe(401);
  expect(await anon.text()).toBe("Unauthorized");
  expect(anon.headers.get("access-control-allow-origin")).toBeNull();
  expect(anon.headers.get("cache-control")).toContain("private, no-store");
  const options = await app.fetch(davUrl(minted.driveId, ""), { method: "OPTIONS", headers: { origin: "https://evil.example" } });
  expect(options.status).toBe(401);
  expect(await options.text()).toBe("Unauthorized");
  const wrong = await app.fetch(davUrl(minted.driveId, "note.txt"), {
    headers: { authorization: `Basic ${btoa(`${minted.driveId}:nope`)}` },
  });
  expect(wrong.status).toBe(401);
  expect(await wrong.text()).not.toContain("secret");
  expect((await app.bucket.list()).objects.some((object) => object.key.endsWith("note.txt"))).toBe(true);
});

test("a verified email can mint one drive", async () => {
  const app = await createTestApp();
  const missing = await post(app, "/api/mint", { email: "ada@example.com", turnstileToken: "ok" });
  expect(missing.status).toBe(400);
  const sent = await post(app, "/api/mint", { email: "Ada.Lovelace+tag@gmail.com", aup: true, turnstileToken: "ok" }, { "cf-connecting-ip": "203.0.113.20" });
  expect(sent.status).toBe(200);
  expect(app.emails).toHaveLength(1);
  expect(app.emails[0]?.to).toBe("adalovelace@gmail.com");
  expect(app.emails[0]?.text).toContain("verify=");
  const token = ((await (await app.fetch(`${ORIGIN}/api/dev/outbox`)).json()) as { token: string }).token;
  const verified = await post(app, "/api/verify", { token });
  expect(verified.status).toBe(200);
  const body = (await verified.json()) as { driveId: string; password: string };
  expect(body.driveId.startsWith("drv_")).toBe(true);
  expect(body.password.length).toBeGreaterThan(10);
  expect(verified.headers.get("set-cookie")).toContain("r2drive_session=");
  expect((await post(app, "/api/verify", { token })).status).toBe(400);
  const again = await post(app, "/api/mint", { email: "ada.lovelace@gmail.com", aup: true, turnstileToken: "ok" });
  expect(again.status).toBe(409);
  const remote = await app.fetch("https://r2-drive.tech-demos.theserverless.dev/api/dev/outbox");
  expect(remote.status).toBe(200);
  const deployed = await createTestApp({ publicOrigin: "https://r2-drive.tech-demos.theserverless.dev" });
  expect((await deployed.fetch("https://r2-drive.tech-demos.theserverless.dev/api/dev/outbox")).status).toBe(404);
});

test("disposable domains are rejected before mail is sent", async () => {
  const app = await createTestApp();
  const rejected = await post(app, "/api/mint", { email: "ada@mailinator.com", aup: true, turnstileToken: "ok" });
  expect(rejected.status).toBe(400);
  const body = (await rejected.json()) as { error: { code: string } };
  expect(body.error.code).toBe("disposable_email");
  expect(app.emails).toHaveLength(0);
  expect(app.repo.verifications).toHaveLength(0);
});

test("the kill switch freezes a drive and stops minting", async () => {
  const off = await createTestApp({ mintEnabled: false });
  const blocked = await post(off, "/api/mint", { email: "ada@example.com", aup: true, turnstileToken: "ok" });
  expect(blocked.status).toBe(403);
  const forced = await post(off, "/api/admin/mint", { enabled: true }, { authorization: "Bearer admin-secret" });
  expect(forced.status).toBe(409);

  const app = await createTestApp();
  const minted = await mintDrive(app, "ada@example.com", "203.0.113.10");
  const bad = await post(app, "/api/admin/freeze", { driveId: minted.driveId }, { authorization: "Bearer wrong" });
  expect(bad.status).toBe(401);
  const frozen = await post(app, "/api/admin/freeze", { driveId: minted.driveId }, { authorization: "Bearer admin-secret" });
  expect(frozen.status).toBe(200);
  const put = await app.fetch(davUrl(minted.driveId, "note.txt"), {
    method: "PUT",
    headers: { authorization: `Basic ${btoa(`${minted.driveId}:${minted.password}`)}` },
    body: "no",
  });
  expect(put.status).toBe(403);

  const reported = await createTestApp();
  const live = await mintDrive(reported, "ada@example.com", "203.0.113.10");
  const report = await post(reported, "/api/report", {
    driveId: live.driveId,
    reason: "This drive is hosting something that should be removed.",
    turnstileToken: "ok",
  });
  expect(report.status).toBe(202);
  expect(((await report.json()) as { frozen: boolean }).frozen).toBe(true);
  const sameNet = await post(
    reported,
    "/api/mint",
    { email: "other@example.com", aup: true, turnstileToken: "ok" },
    { "cf-connecting-ip": "203.0.113.50" },
  );
  expect(sameNet.status).toBe(403);
  const otherNet = await post(
    reported,
    "/api/mint",
    { email: "fresh@example.com", aup: true, turnstileToken: "ok" },
    { "cf-connecting-ip": "198.51.100.20" },
  );
  expect(otherNet.status).toBe(200);

  const stopped = await post(reported, "/api/admin/mint", { enabled: false }, { authorization: "Bearer admin-secret" });
  expect(((await stopped.json()) as { mintEnabled: boolean }).mintEnabled).toBe(false);
  const after = await post(
    reported,
    "/api/mint",
    { email: "later@example.com", aup: true, turnstileToken: "ok" },
    { "cf-connecting-ip": "198.51.100.30" },
  );
  expect(after.status).toBe(403);

  const day = new Date(reported.clock.t).toISOString().slice(0, 10);
  await reported.repo.setMintKilled(false);
  reported.repo.daily.clear();
  for (let i = 0; i < DAILY_MINT_CAP; i++) expect(await reported.repo.tryIncrementDaily(day, DAILY_MINT_CAP)).toBe(true);
  const capped = await post(
    reported,
    "/api/mint",
    { email: "capped@example.com", aup: true, turnstileToken: "ok" },
    { "cf-connecting-ip": "192.0.2.10" },
  );
  expect(capped.status).toBe(429);
});
