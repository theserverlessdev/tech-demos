import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { DAILY_EMAIL_CAP, FROZEN_KEEP_MS, MAX_DRIVE_REQUESTS, MAX_FILE_BYTES } from "../shared/constants";
import { zipDeflated, zipStored } from "../shared/zip-fixture";
import { MemoryBucket } from "./bucket";
import { completeWipe, wipeDecision } from "./drive-wipe";
import { DriveSession } from "./drive-session";
import { MemoryLockStore } from "./locks";
import { bunSql } from "./sqlite-bun";
import { BUDGET_EXHAUSTED_MESSAGE } from "./requests";
import { authHeaders, createTestApp, davUrl, mintDrive, type TestApp } from "./test-app";

const ORIGIN = "http://127.0.0.1:8808";
const text = (value: string) => new TextEncoder().encode(value);

function dav(app: TestApp, minted: Awaited<ReturnType<typeof mintDrive>>, method: string, key: string, body?: BodyInit | null, headers?: HeadersInit) {
  const init: RequestInit = { method, headers: authHeaders(minted, headers) };
  if (body !== undefined && body !== null) init.body = body;
  return app.fetch(davUrl(minted.driveId, key), init);
}

test("ten concurrent 5 MB puts stay inside 25 MB", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app);
  const body = new Uint8Array(MAX_FILE_BYTES);
  body.fill(0x61);
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, index) => dav(app, minted, "PUT", `bulk-${index}.txt`, body.slice())),
  );
  const created = results.filter((response) => response.status === 201);
  expect(created).toHaveLength(5);
  const page = await app.bucket.list({ prefix: `drives/${minted.driveId}/` });
  const stored = page.objects.reduce((sum, object) => sum + object.size, 0);
  expect(stored).toBe(5 * MAX_FILE_BYTES);
  expect(stored).toBeLessThanOrEqual(25 * 1024 * 1024);
});

test("250 concurrent 1-byte puts store at most 200 objects", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app);
  const results = await Promise.all(Array.from({ length: 250 }, (_, index) => dav(app, minted, "PUT", `n-${index}.txt`, "x")));
  const created = results.filter((response) => response.status === 201);
  expect(created.length).toBeLessThanOrEqual(200);
  expect(created).toHaveLength(200);
  const page = await app.bucket.list({ prefix: `drives/${minted.driveId}/` });
  expect(page.objects.length).toBeLessThanOrEqual(200);
});

test("a failed collection copy leaves the quota equal to the stored bytes", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app);
  expect((await dav(app, minted, "MKCOL", "notes")).status).toBe(201);
  expect((await dav(app, minted, "MKCOL", "wide")).status).toBe(201);
  expect((await dav(app, minted, "PUT", "notes/ok.txt", "hi")).status).toBe(201);
  const longName = `${"n".repeat(880)}.txt`;
  expect((await dav(app, minted, "PUT", `notes/${longName}`, "hi")).status).toBe(201);
  const destination = `${ORIGIN}/dav/${minted.driveId}/wide/${"d".repeat(30)}`;
  const copied = await dav(app, minted, "COPY", "notes", null, { Destination: destination, Depth: "infinity" });
  expect(copied.status).toBe(414);
  const page = await app.bucket.list({ prefix: `drives/${minted.driveId}/` });
  const stored = page.objects.reduce((sum, object) => sum + object.size, 0);
  const drive = app.repo.drives.find((row) => row.id === minted.driveId);
  expect(drive?.bytesUsed).toBe(stored);
  expect(drive?.fileCount).toBe(page.objects.length);
});

test("content holes and office packages return 415", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app);
  const pdf = text("%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF\n");
  const zip = text("PK\u0003\u0004");
  const polyglot = new Uint8Array(pdf.byteLength + 8);
  polyglot.set(pdf);
  polyglot.set([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0], pdf.byteLength);
  expect((await dav(app, minted, "PUT", "poly.pdf", polyglot)).status).toBe(415);
  const ole = new Uint8Array(1024);
  ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  expect((await dav(app, minted, "PUT", "old.doc", ole)).status).toBe(415);
  const dat = zipStored([
    { name: "[Content_Types].xml", data: text("<Types/>") },
    { name: "word/document.xml", data: text("<w:document/>") },
    { name: "word/a.dat", data: text("no") },
  ]);
  expect((await dav(app, minted, "PUT", "bad.docx", dat)).status).toBe(415);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const xmlPng = zipStored([
    { name: "[Content_Types].xml", data: text("<Types/>") },
    { name: "word/x.xml", data: png },
  ]);
  expect((await dav(app, minted, "PUT", "png.docx", xmlPng)).status).toBe(415);
  expect((await dav(app, minted, "PUT", "note.txt", "\n-----BEGIN PGP MESSAGE-----\n")).status).toBe(415);
  const docx = await zipDeflated([
    { name: "[Content_Types].xml", data: text(`<?xml version="1.0"?><Types/>`) },
    { name: "_rels/.rels", data: text(`<?xml version="1.0"?><Relationships/>`) },
    { name: "word/document.xml", data: text(`<?xml version="1.0"?><w:document/>`) },
    { name: "word/_rels/document.xml.rels", data: text(`<?xml version="1.0"?><Relationships/>`) },
  ]);
  expect((await dav(app, minted, "PUT", "hello.docx", docx)).status).toBe(415);
  const pngZip = zipStored([{ name: "hidden.png", data: png }]);
  const appended = new Uint8Array(docx.byteLength + 4 + pngZip.byteLength);
  appended.set(docx);
  appended.set([0x50, 0x4b, 0x01, 0x02], docx.byteLength);
  appended.set(pngZip, docx.byteLength + 4);
  expect((await dav(app, minted, "PUT", "trailer.docx", appended)).status).toBe(415);
  const trailed = new Uint8Array(docx.byteLength + 1);
  trailed.set(docx);
  expect((await dav(app, minted, "PUT", "trail.docx", trailed)).status).toBe(415);
  const commented = new Uint8Array(docx.byteLength + 10);
  commented.set(docx);
  commented[docx.byteLength - 2] = 10;
  expect((await dav(app, minted, "PUT", "comment.docx", commented)).status).toBe(415);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const encoded = await zipDeflated([
    { name: "[Content_Types].xml", data: text(`<?xml version="1.0"?><Types/>`) },
    { name: "word/document.xml", data: text(`<a>${alphabet.repeat(7).slice(0, 400)}`) },
  ]);
  expect((await dav(app, minted, "PUT", "encoded.docx", encoded)).status).toBe(415);
  expect(zip.byteLength).toBeGreaterThan(0);
});

test("one drive shares a DAV budget across IP addresses and a GET does not write usage", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app);
  const seen: string[] = [];
  app.setLimit(async (name, key) => {
    if (name !== "DAV_DRIVE") return true;
    seen.push(key);
    return seen.length <= 2;
  });
  let updates = 0;
  const original = app.repo.updateUsage.bind(app.repo);
  app.repo.updateUsage = async (id, bytes, files) => {
    updates += 1;
    return original(id, bytes, files);
  };
  const first = await app.fetch(davUrl(minted.driveId, "a.txt"), {
    method: "GET",
    headers: { ...Object.fromEntries(authHeaders(minted)), "cf-connecting-ip": "203.0.113.10" },
  });
  const second = await app.fetch(davUrl(minted.driveId, "a.txt"), {
    method: "GET",
    headers: { ...Object.fromEntries(authHeaders(minted)), "cf-connecting-ip": "198.51.100.20" },
  });
  expect(first.status).toBe(404);
  expect(second.status).toBe(404);
  expect(updates).toBe(0);
  expect(seen).toEqual([minted.driveId, minted.driveId]);
  const third = await app.fetch(davUrl(minted.driveId, "a.txt"), { headers: authHeaders(minted) });
  expect(third.status).toBe(429);
  expect((await dav(app, minted, "PUT", "a.txt", "hi")).status).toBe(429);
});

test("the hub path redirects to the demo host", async () => {
  const app = await createTestApp();
  const response = await app.fetch("http://127.0.0.1:8808/demos/r2-drive/api/health");
  expect(response.status).toBe(308);
  expect(response.headers.get("location")).toBe("https://r2-drive.tech-demos.theserverless.dev/api/health");
});

test("a pdf download is an attachment with a sandbox policy", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app);
  const pdf = "%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n";
  expect((await dav(app, minted, "PUT", "note.pdf", pdf)).status).toBe(201);
  const read = await dav(app, minted, "GET", "note.pdf");
  expect(read.status).toBe(200);
  expect(read.headers.get("content-disposition")).toContain("attachment");
  expect(read.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
});

test("finder metadata files are stored and oversized ones are refused", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app);
  const jpeg = new Uint8Array(64);
  jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
  expect((await dav(app, minted, "PUT", "._a.jpg", jpeg)).status).toBe(415);
  const noise = new Uint8Array(32);
  noise.fill(0xff);
  expect((await dav(app, minted, "PUT", ".DS_Store", noise)).status).toBe(415);
  const apple = new Uint8Array(26);
  apple.set([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00]);
  expect((await dav(app, minted, "PUT", "._note.txt", apple)).status).toBe(201);
  const planted = new Uint8Array(40);
  planted.set([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00]);
  planted.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 26);
  expect((await dav(app, minted, "PUT", "._planted.txt", planted)).status).toBe(415);
  const store = new Uint8Array(32);
  store.set([0x00, 0x00, 0x00, 0x01, 0x42, 0x75, 0x64, 0x31]);
  expect((await dav(app, minted, "PUT", ".DS_Store", store)).status).toBe(201);
  const huge = new Uint8Array(70 * 1024);
  huge.set([0x00, 0x00, 0x00, 0x01, 0x42, 0x75, 0x64, 0x31]);
  expect((await dav(app, minted, "PUT", ".DS_Store", huge)).status).toBe(413);
});

test("move rejects an ancestor target and a locked descendant", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app);
  expect((await dav(app, minted, "MKCOL", "folder")).status).toBe(201);
  expect((await dav(app, minted, "PUT", "folder/child.txt", "x")).status).toBe(201);
  const onto = await dav(app, minted, "MOVE", "folder/child.txt", null, {
    Destination: `${ORIGIN}/dav/${minted.driveId}/folder`,
    Overwrite: "T",
  });
  expect(onto.status).toBe(400);
  expect((await dav(app, minted, "GET", "folder/child.txt")).status).toBe(200);
  const locked = await dav(
    app,
    minted,
    "LOCK",
    "folder/child.txt",
    `<?xml version="1.0"?><lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope><locktype><write/></locktype></lockinfo>`,
  );
  expect(locked.status).toBe(201);
  const moved = await dav(app, minted, "MOVE", "folder", null, {
    Destination: `${ORIGIN}/dav/${minted.driveId}/renamed`,
  });
  expect(moved.status).toBe(423);
});

test("a put after expiry is rejected and a nameless alarm still deletes the prefix", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app);
  expect((await dav(app, minted, "PUT", "note.txt", "x")).status).toBe(201);
  app.clock.t = minted.expiresAt + 1;
  expect((await dav(app, minted, "PUT", "note.txt", "y")).status).toBe(401);

  const bucket = new MemoryBucket();
  await bucket.put("drives/drv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/note.txt", text("kept"));
  let deleted = false;
  const wiped = await completeWipe({
    name: undefined,
    storedId: "drv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    bucket,
    markWiped: async () => undefined,
    deleteAll: async () => {
      deleted = true;
    },
    now: 1,
  });
  expect(wiped).toBe(true);
  expect(deleted).toBe(true);
  expect((await bucket.list({ prefix: "drives/drv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/" })).objects).toHaveLength(0);
  const missing = await completeWipe({
    name: undefined,
    storedId: undefined,
    bucket,
    markWiped: async () => undefined,
    deleteAll: async () => undefined,
    now: 1,
  });
  expect(missing).toBe(false);

  const database = new Database(":memory:");
  const session = new DriveSession({
    sql: bunSql(database),
    bucket: new MemoryBucket(),
    locks: new MemoryLockStore(),
    audit: async () => undefined,
  });
  const late = await session.handle(new Request("http://127.0.0.1/dav/x/a.txt", { method: "PUT", body: "no" }), "/dav/x", "a.txt", () => 10, 10);
  expect(late.status).toBe(410);
  const unscheduled = await session.handle(new Request("http://127.0.0.1/dav/x/b.txt", { method: "PUT", body: "no" }), "/dav/x", "b.txt", () => 10, null);
  expect(unscheduled.status).toBe(410);
});

test("a frozen drive stays until release or the retention window", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app);
  expect((await dav(app, minted, "PUT", "note.txt", "evidence")).status).toBe(201);
  const frozen = await app.fetch(`${ORIGIN}/api/admin/freeze`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
    body: JSON.stringify({ driveId: minted.driveId }),
  });
  expect(frozen.status).toBe(200);
  const frozenAt = app.repo.drives[0]?.frozenAt ?? 0;
  app.clock.t += 2 * 60 * 60 * 1000;
  const decision = await app.alarm(minted.driveId);
  expect(decision.action).toBe("defer");
  if (decision.action === "defer") expect(decision.until).toBe(frozenAt + FROZEN_KEEP_MS);
  expect(wipeDecision({ status: "frozen", expiresAt: minted.expiresAt, frozenAt }, minted.expiresAt + 1).action).toBe("defer");
  expect(wipeDecision({ status: "frozen", expiresAt: minted.expiresAt, frozenAt }, frozenAt + FROZEN_KEEP_MS).action).toBe("wipe");
  const session = await app.fetch(`${ORIGIN}/api/session`, { headers: { cookie: minted.cookie } });
  expect(session.status).toBe(403);
  expect(await app.sweep()).toBe(0);
  expect(app.repo.drives[0]?.status).toBe("frozen");
  expect((await app.bucket.list()).objects.length).toBe(1);
  expect((await dav(app, minted, "GET", "note.txt")).status).toBe(403);
  const again = await app.fetch(`${ORIGIN}/api/mint`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ada@example.com", aup: true, turnstileToken: "ok" }),
  });
  expect(again.status).toBe(409);

  const released = await createTestApp();
  const other = await mintDrive(released, "release@example.com", "203.0.113.44");
  expect((await dav(released, other, "PUT", "note.txt", "x")).status).toBe(201);
  await released.fetch(`${ORIGIN}/api/admin/freeze`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
    body: JSON.stringify({ driveId: other.driveId }),
  });
  const release = await released.fetch(`${ORIGIN}/api/admin/release`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
    body: JSON.stringify({ driveId: other.driveId }),
  });
  expect(release.status).toBe(200);
  expect(released.repo.drives[0]?.status).toBe("wiped");
  expect((await released.bucket.list()).objects).toHaveLength(0);

  app.clock.t += 30 * 24 * 60 * 60 * 1000;
  expect(await app.sweep()).toBe(1);
  expect(app.repo.drives[0]?.status).toBe("wiped");
  expect((await app.bucket.list()).objects).toHaveLength(0);
});

test("a put queued after expiry gets 410", async () => {
  const clock = { t: 1_000 };
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let held = false;
  const inner = new MemoryBucket();
  const session = new DriveSession({
    sql: bunSql(new Database(":memory:")),
    bucket: {
      head: (key) => inner.head(key),
      get: (key) => inner.get(key),
      list: (options) => inner.list(options),
      delete: (keys) => inner.delete(keys),
      put: async (key, body, options) => {
        if (key === "slow.txt" && !held) {
          held = true;
          entered();
          await gate;
        }
        return inner.put(key, body, options);
      },
    },
    locks: new MemoryLockStore(),
    audit: async () => undefined,
  });
  const first = session.handle(new Request("http://127.0.0.1/dav/x/slow.txt", { method: "PUT", body: "slow" }), "/dav/x", "slow.txt", () => clock.t, 5_000);
  await started;
  clock.t = 5_000;
  const second = session.handle(new Request("http://127.0.0.1/dav/x/late.txt", { method: "PUT", body: "late" }), "/dav/x", "late.txt", () => clock.t, 5_000);
  release();
  expect((await first).status).toBe(201);
  expect((await second).status).toBe(410);
});

test("repeat mints for a live drive do not spend the email cap", async () => {
  const app = await createTestApp();
  await mintDrive(app);
  const before = await app.repo.dailyCount("email", "2026-10-23");
  for (let index = 0; index < 5; index++) {
    const again = await app.fetch(`${ORIGIN}/api/mint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com", aup: true, turnstileToken: "ok" }),
    });
    expect(again.status).toBe(409);
  }
  expect(await app.repo.dailyCount("email", "2026-10-23")).toBe(before);
});

test("unverified mints do not spend the drive cap", async () => {
  const app = await createTestApp();
  for (let index = 0; index < DAILY_EMAIL_CAP; index++) {
    const sent = await app.fetch(`${ORIGIN}/api/mint`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": `203.0.113.${(index % 200) + 1}` },
      body: JSON.stringify({ email: `person${index}@example.com`, aup: true, turnstileToken: "ok" }),
    });
    expect(sent.status).toBe(200);
  }
  const token = decodeURIComponent(/verify=([^\s]+)/.exec(app.emails[0]?.text ?? "")?.[1] ?? "");
  const verified = await app.fetch(`${ORIGIN}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  expect(verified.status).toBe(200);
  const extra = await app.fetch(`${ORIGIN}/api/mint`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "extra@example.com", aup: true, turnstileToken: "ok" }),
  });
  expect(extra.status).toBe(429);
  const body = (await extra.json()) as { error: { code: string } };
  expect(body.error.code).toBe("daily_email_cap");
});

test("missing audit keys fail closed and oversized json is refused up front", async () => {
  const app = await createTestApp({ configured: false });
  const report = await app.fetch(`${ORIGIN}/api/report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "This report should not be stored.", turnstileToken: "ok" }),
  });
  expect(report.status).toBe(503);
  const live = await createTestApp();
  const oversized = await live.fetch(`${ORIGIN}/api/mint`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "40000" },
    body: "{}",
  });
  expect(oversized.status).toBe(413);
  const config = await live.fetch(`${ORIGIN}/api/config`);
  const payload = (await config.json()) as { rateLimits?: unknown };
  expect(payload.rateLimits).toBeUndefined();
});

test("an infinite lock does not outlive the drive", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app);
  expect((await dav(app, minted, "PUT", "note.txt", "x")).status).toBe(201);
  const locked = await dav(
    app,
    minted,
    "LOCK",
    "note.txt",
    `<?xml version="1.0"?><lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope><locktype><write/></locktype></lockinfo>`,
    { Timeout: "Infinite" },
  );
  expect(locked.status).toBe(201);
  const listed = (await (await app.fetch(`${ORIGIN}/api/locks`, { headers: { cookie: minted.cookie } })).json()) as {
    locks: { expiresAt: number }[];
  };
  expect(listed.locks[0]?.expiresAt).toBeLessThanOrEqual(minted.expiresAt);
});

test("a second report leaves frozen_at unchanged", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app);
  const body = JSON.stringify({
    driveId: minted.driveId,
    reason: "This drive is hosting something that should be removed.",
    turnstileToken: "ok",
  });
  const first = await app.fetch(`${ORIGIN}/api/report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  expect(first.status).toBe(202);
  const frozenAt = app.repo.drives[0]?.frozenAt;
  expect(typeof frozenAt).toBe("number");
  app.clock.t += 60_000;
  const second = await app.fetch(`${ORIGIN}/api/report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  expect(second.status).toBe(202);
  expect(app.repo.drives[0]?.frozenAt).toBe(frozenAt);
});

test("a 10-file MOVE uses 11 units", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app, "move10@example.com", "203.0.113.50");
  expect((await dav(app, minted, "MKCOL", "folder")).status).toBe(201);
  for (let index = 0; index < 10; index++) {
    expect((await dav(app, minted, "PUT", `folder/n${index}.txt`, "x")).status).toBe(201);
  }
  const before = app.unitsUsed(minted.driveId);
  const moved = await dav(app, minted, "MOVE", "folder", null, {
    Destination: `${ORIGIN}/dav/${minted.driveId}/elsewhere`,
  });
  expect(moved.status).toBe(201);
  expect(app.unitsUsed(minted.driveId) - before).toBe(11);
  expect((await dav(app, minted, "GET", "elsewhere/n0.txt")).status).toBe(200);
  expect((await dav(app, minted, "GET", "folder/n0.txt")).status).toBe(404);
});

test("a 20-file MOVE at 2990 units gets 429 and leaves the source", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app, "move20@example.com", "203.0.113.51");
  expect((await dav(app, minted, "MKCOL", "folder")).status).toBe(201);
  for (let index = 0; index < 20; index++) {
    expect((await dav(app, minted, "PUT", `folder/n${index}.txt`, "x")).status).toBe(201);
  }
  app.setUnitsUsed(minted.driveId, 2990);
  const logged = await capturingErrors(async () => {
    const moved = await dav(app, minted, "MOVE", "folder", null, {
      Destination: `${ORIGIN}/dav/${minted.driveId}/elsewhere`,
    });
    expect(moved.status).toBe(429);
    expect(await moved.text()).toBe("This copy/move needs 21 units; 9 left.");
    expect(app.unitsUsed(minted.driveId)).toBe(2991);
  });
  expect(logged).toContain("drive_budget_exhausted");
  expect(logged).toContain(`"driveId":"${minted.driveId}"`);
  expect(logged).toContain('"needed":21');
  expect(logged).toContain('"used":2991');
  expect((await dav(app, minted, "GET", "folder/n0.txt")).status).toBe(200);
  expect(await (await dav(app, minted, "GET", "folder/n0.txt")).text()).toBe("x");
  expect((await dav(app, minted, "GET", "elsewhere/n0.txt")).status).toBe(404);
  expect((await dav(app, minted, "GET", "elsewhere")).status).toBe(404);
});

test("a folder COPY at Depth infinity charges one unit per object", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app, "copyinf@example.com", "203.0.113.52");
  expect((await dav(app, minted, "MKCOL", "folder")).status).toBe(201);
  for (let index = 0; index < 4; index++) {
    expect((await dav(app, minted, "PUT", `folder/n${index}.txt`, "x")).status).toBe(201);
  }
  const before = app.unitsUsed(minted.driveId);
  const copied = await dav(app, minted, "COPY", "folder", null, {
    Destination: `${ORIGIN}/dav/${minted.driveId}/elsewhere`,
    Depth: "infinity",
  });
  expect(copied.status).toBe(201);
  expect(app.unitsUsed(minted.driveId) - before).toBe(5);
  expect((await dav(app, minted, "GET", "elsewhere/n0.txt")).status).toBe(200);
});

test("a failed overwrite COPY leaves the destination intact", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app, "overwrite@example.com", "203.0.113.53");
  expect((await dav(app, minted, "MKCOL", "src")).status).toBe(201);
  for (let index = 0; index < 10; index++) {
    expect((await dav(app, minted, "PUT", `src/n${index}.txt`, "s")).status).toBe(201);
  }
  expect((await dav(app, minted, "MKCOL", "dest")).status).toBe(201);
  expect((await dav(app, minted, "PUT", "dest/keep.txt", "keep")).status).toBe(201);
  app.setUnitsUsed(minted.driveId, 2995);
  const logged = await capturingErrors(async () => {
    const copied = await dav(app, minted, "COPY", "src", null, {
      Destination: `${ORIGIN}/dav/${minted.driveId}/dest`,
      Depth: "infinity",
      Overwrite: "T",
    });
    expect(copied.status).toBe(429);
    expect(await copied.text()).toBe("This copy/move needs 11 units; 4 left.");
    expect(app.unitsUsed(minted.driveId)).toBe(2996);
  });
  expect(logged).toContain("drive_budget_exhausted");
  expect(logged).toContain(`"driveId":"${minted.driveId}"`);
  expect(logged).toContain('"needed":11');
  expect(logged).toContain('"used":2996');
  expect(await (await dav(app, minted, "GET", "dest/keep.txt")).text()).toBe("keep");
  expect((await dav(app, minted, "GET", "src/n0.txt")).status).toBe(200);
  expect((await dav(app, minted, "GET", "dest/n0.txt")).status).toBe(404);
});

test("a Depth 0 folder COPY costs 1 unit", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app, "depth0@example.com", "203.0.113.54");
  expect((await dav(app, minted, "MKCOL", "folder")).status).toBe(201);
  expect((await dav(app, minted, "PUT", "folder/note.txt", "inside")).status).toBe(201);
  const before = app.unitsUsed(minted.driveId);
  const copied = await dav(app, minted, "COPY", "folder", null, {
    Destination: `${ORIGIN}/dav/${minted.driveId}/shallow`,
    Depth: "0",
  });
  expect(copied.status).toBe(201);
  expect(app.unitsUsed(minted.driveId) - before).toBe(1);
  expect((await dav(app, minted, "GET", "shallow/note.txt")).status).toBe(404);
  expect(await (await dav(app, minted, "GET", "folder/note.txt")).text()).toBe("inside");
});

test("a COPY that lands on exactly 3000 units succeeds and the next unit fails", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app, "boundary@example.com", "203.0.113.55");
  expect((await dav(app, minted, "MKCOL", "folder")).status).toBe(201);
  expect((await dav(app, minted, "PUT", "folder/a.txt", "a")).status).toBe(201);
  expect((await dav(app, minted, "PUT", "folder/b.txt", "b")).status).toBe(201);
  app.setUnitsUsed(minted.driveId, 2997);
  const copied = await dav(app, minted, "COPY", "folder", null, {
    Destination: `${ORIGIN}/dav/${minted.driveId}/elsewhere`,
    Depth: "infinity",
  });
  expect(copied.status).toBe(201);
  expect(app.unitsUsed(minted.driveId)).toBe(3000);
  const stored = await app.bucket.list({ prefix: `drives/${minted.driveId}/elsewhere/` });
  expect(stored.objects.some((object) => object.key.endsWith("elsewhere/a.txt"))).toBe(true);
  const logged = await capturingErrors(async () => {
    const over = await app.fetch(davUrl(minted.driveId, "missing.txt"), { headers: authHeaders(minted) });
    expect(over.status).toBe(429);
    expect(await over.text()).toBe(BUDGET_EXHAUSTED_MESSAGE);
  });
  expect(logged).toContain("drive_budget_exhausted");
  expect(logged).toContain(`"driveId":"${minted.driveId}"`);
  expect(logged).toContain('"needed":1');
  expect(logged).toContain('"used":3000');
});

test("request 3001 on a drive gets 429", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app);
  for (let index = 0; index < MAX_DRIVE_REQUESTS; index++) {
    const response = await app.fetch(davUrl(minted.driveId, "missing.txt"), { headers: authHeaders(minted) });
    expect(response.status).toBe(404);
  }
  const logged = await capturingErrors(async () => {
    const over = await app.fetch(davUrl(minted.driveId, "missing.txt"), {
      headers: authHeaders(minted, { "cf-connecting-ip": "198.51.100.40" }),
    });
    expect(over.status).toBe(429);
    expect(await over.text()).toBe(BUDGET_EXHAUSTED_MESSAGE);
  });
  expect(logged).toContain("drive_budget_exhausted");
});

async function capturingErrors(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.error = original;
  }
  return lines.join("\n");
}
