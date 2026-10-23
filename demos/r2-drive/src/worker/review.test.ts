import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { DAILY_EMAIL_CAP, MAX_FILE_BYTES } from "../shared/constants";
import { zipDeflated } from "../shared/content-policy";
import { MemoryBucket } from "./bucket";
import { completeWipe } from "./drive-wipe";
import { DriveSession } from "./drive-session";
import { MemoryLockStore } from "./locks";
import { bunSql } from "./sqlite-bun";
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

test("content holes return 415 and a real docx returns 201", async () => {
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
  const { zipStored } = await import("../shared/content-policy");
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
  expect((await dav(app, minted, "PUT", "hello.docx", docx)).status).toBe(201);
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
  const store = new Uint8Array(32);
  store[0] = 0xff;
  expect((await dav(app, minted, "PUT", ".DS_Store", store)).status).toBe(201);
  expect((await dav(app, minted, "PUT", "._note.txt", store)).status).toBe(201);
  const huge = new Uint8Array(70 * 1024);
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
  const late = await session.handle(new Request("http://127.0.0.1/dav/x/a.txt", { method: "PUT", body: "no" }), "/dav/x", "a.txt", 10, 10);
  expect(late.status).toBe(410);
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
  app.clock.t += 2 * 60 * 60 * 1000;
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
