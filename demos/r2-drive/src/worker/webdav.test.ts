import { expect, test } from "bun:test";
import { DRIVE_TTL_MS, MAX_FILE_BYTES, MAX_FILES } from "../shared/constants";
import { authHeaders, createTestApp, davUrl, mintDrive, type TestApp } from "./test-app";

const ORIGIN = "http://127.0.0.1:8808";

async function drive(app?: TestApp) {
  const created = app ?? (await createTestApp());
  const minted = await mintDrive(created);
  return { app: created, minted };
}

function dav(app: TestApp, minted: Awaited<ReturnType<typeof mintDrive>>, method: string, key: string, body?: BodyInit | null, headers?: HeadersInit) {
  const init: RequestInit = { method, headers: authHeaders(minted, headers) };
  if (body !== undefined && body !== null) init.body = body;
  return app.fetch(davUrl(minted.driveId, key), init);
}

test("an empty If list and DAV:no-lock do not authorize a write", async () => {
  const { app, minted } = await drive();
  expect((await dav(app, minted, "PUT", "note.txt", "one")).status).toBe(201);
  expect((await dav(app, minted, "PUT", "note.txt", "two", { If: "()" })).status).toBe(412);
  expect((await dav(app, minted, "PUT", "note.txt", "two", { If: "(<DAV:no-lock>)" })).status).toBe(412);
  const locked = await dav(
    app,
    minted,
    "LOCK",
    "note.txt",
    `<?xml version="1.0"?><lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope><locktype><write/></locktype></lockinfo>`,
  );
  const token = locked.headers.get("lock-token") ?? "";
  expect((await dav(app, minted, "PUT", "note.txt", "two", { If: `(${token}) (Not <DAV:no-lock>)` })).status).toBe(204);
  expect(await (await dav(app, minted, "GET", "note.txt")).text()).toBe("two");
});

test("class 1 methods create, copy, move, and delete a file", async () => {
  const { app, minted } = await drive();
  const options = await dav(app, minted, "OPTIONS", "");
  expect(options.status).toBe(200);
  expect(options.headers.get("dav")).toContain("2");

  const folder = await dav(app, minted, "MKCOL", "notes");
  expect(folder.status).toBe(201);
  const created = await dav(app, minted, "PUT", "notes/a.txt", "alpha");
  expect(created.status).toBe(201);
  const read = await dav(app, minted, "GET", "notes/a.txt");
  expect(await read.text()).toBe("alpha");
  expect(read.headers.get("cache-control")).toContain("no-store");
  const head = await dav(app, minted, "HEAD", "notes/a.txt");
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");

  const found = await dav(app, minted, "PROPFIND", "notes/a.txt", "", { Depth: "0" });
  expect(found.status).toBe(207);
  expect(await found.text()).toContain("a.txt");

  const patched = await dav(
    app,
    minted,
    "PROPPATCH",
    "notes/a.txt",
    `<?xml version="1.0"?><propertyupdate xmlns="DAV:"><set><prop><color xmlns="urn:x">amber</color></prop></set></propertyupdate>`,
  );
  expect(patched.status).toBe(207);

  const copied = await dav(app, minted, "COPY", "notes/a.txt", null, {
    Destination: `${ORIGIN}/dav/${minted.driveId}/notes/b.txt`,
  });
  expect(copied.status).toBe(201);
  const moved = await dav(app, minted, "MOVE", "notes/b.txt", null, {
    Destination: `${ORIGIN}/dav/${minted.driveId}/notes/c.txt`,
  });
  expect(moved.status).toBe(201);
  expect((await dav(app, minted, "GET", "notes/b.txt")).status).toBe(404);
  expect(await (await dav(app, minted, "GET", "notes/c.txt")).text()).toBe("alpha");
  expect((await dav(app, minted, "DELETE", "notes/c.txt")).status).toBe(204);
});

test("locks record owner, timeout, and depth, and expire", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app);
  await dav(app, minted, "PUT", "note.txt", "one");
  const locked = await dav(
    app,
    minted,
    "LOCK",
    "note.txt",
    `<?xml version="1.0"?><lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope><locktype><write/></locktype><owner>ada</owner></lockinfo>`,
    { Timeout: "Second-5", Depth: "0" },
  );
  expect(locked.status).toBe(201);
  const token = locked.headers.get("lock-token") ?? "";
  expect(token.startsWith("<urn:uuid:")).toBe(true);
  expect((await dav(app, minted, "PUT", "note.txt", "two")).status).toBe(423);
  const wrote = await dav(app, minted, "PUT", "note.txt", "two", { If: `(${token})` });
  expect(wrote.status).toBe(204);
  const refreshed = await dav(app, minted, "LOCK", "note.txt", "", { If: `(${token})`, Timeout: "Second-5" });
  expect(refreshed.status).toBe(200);

  const listed = await app.fetch(`${ORIGIN}/api/locks`, { headers: { cookie: minted.cookie } });
  const locks = (await listed.json()) as { locks: { owner: string; timeout: string; depth: string }[] };
  expect(locks.locks[0]).toMatchObject({ owner: "ada", timeout: "Second-5", depth: "0" });

  expect((await dav(app, minted, "UNLOCK", "note.txt", null, { "Lock-Token": token })).status).toBe(204);
  expect((await dav(app, minted, "PUT", "note.txt", "three")).status).toBe(204);

  await dav(app, minted, "MKCOL", "box");
  const deep = await dav(
    app,
    minted,
    "LOCK",
    "box",
    `<?xml version="1.0"?><lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope><locktype><write/></locktype><owner>ada</owner></lockinfo>`,
    { Depth: "infinity" },
  );
  expect((await dav(app, minted, "PUT", "box/child.txt", "no")).status).toBe(423);
  const deepToken = deep.headers.get("lock-token") ?? "";
  expect((await dav(app, minted, "PUT", "box/child.txt", "yes", { If: `(${deepToken})` })).status).toBe(201);

  await dav(app, minted, "PUT", "shared.txt", "s");
  const first = await dav(
    app,
    minted,
    "LOCK",
    "shared.txt",
    `<?xml version="1.0"?><lockinfo xmlns="DAV:"><lockscope><shared/></lockscope><locktype><write/></locktype></lockinfo>`,
  );
  const second = await dav(
    app,
    minted,
    "LOCK",
    "shared.txt",
    `<?xml version="1.0"?><lockinfo xmlns="DAV:"><lockscope><shared/></lockscope><locktype><write/></locktype></lockinfo>`,
  );
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  expect(
    (
      await dav(
        app,
        minted,
        "LOCK",
        "shared.txt",
        `<?xml version="1.0"?><lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope><locktype><write/></locktype></lockinfo>`,
      )
    ).status,
  ).toBe(423);

  app.clock.t += 6_000;
  await dav(app, minted, "PUT", "short.txt", "s");
  const expiring = await dav(
    app,
    minted,
    "LOCK",
    "short.txt",
    `<?xml version="1.0"?><lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope><locktype><write/></locktype></lockinfo>`,
    { Timeout: "Second-5" },
  );
  expect(expiring.status).toBe(201);
  app.clock.t += 6_000;
  expect((await dav(app, minted, "PUT", "short.txt", "later")).status).toBe(204);
});

test("two drives cannot read or move into each other", async () => {
  const app = await createTestApp();
  const ada = await mintDrive(app, "ada@example.com", "203.0.113.10");
  const byron = await mintDrive(app, "byron@example.com", "198.51.100.8");
  expect((await dav(app, ada, "PUT", "secret.txt", "ada only")).status).toBe(201);
  const stolen = await app.fetch(davUrl(byron.driveId, "secret.txt"), { headers: authHeaders(ada) });
  expect(stolen.status).toBe(401);
  const missing = await dav(app, byron, "GET", "secret.txt");
  expect(missing.status).toBe(404);
  const moved = await dav(app, ada, "MOVE", "secret.txt", null, {
    Destination: `${ORIGIN}/dav/${byron.driveId}/secret.txt`,
  });
  expect(moved.status).toBe(400);
  const escaped = await app.fetch(`${ORIGIN}/dav/${ada.driveId}/%2e%2e/${byron.driveId}/secret.txt`, { headers: authHeaders(ada) });
  expect(escaped.status).toBe(401);
  expect(await escaped.text()).toBe("Unauthorized");
  const listed = await app.bucket.list();
  expect(listed.objects.length).toBeGreaterThan(0);
  for (const object of listed.objects) expect(object.key.startsWith(`drives/${ada.driveId}/`)).toBe(true);
});

test("caps stop a large file, a large drive, and the 201st object", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app);
  const huge = await app.fetch(davUrl(minted.driveId, "big.txt"), {
    method: "PUT",
    headers: authHeaders(minted, { "content-length": String(MAX_FILE_BYTES + 1) }),
    body: "hello",
  });
  expect(huge.status).toBe(413);

  const five = new Uint8Array(MAX_FILE_BYTES);
  five.fill(0x61);
  for (let i = 0; i < 5; i++) expect((await dav(app, minted, "PUT", `part-${i}.txt`, five)).status).toBe(201);
  expect((await dav(app, minted, "PUT", "overflow.txt", "x")).status).toBe(413);

  const fresh = await createTestApp();
  const other = await mintDrive(fresh, "files@example.com");
  for (let i = 0; i < MAX_FILES; i++) {
    const status = (await dav(fresh, other, "PUT", `n-${i}.txt`, "x")).status;
    expect(status).toBe(201);
  }
  expect((await dav(fresh, other, "PUT", "one-more.txt", "x")).status).toBe(413);
});

test("the hour wipe removes objects and keeps the audit row for 30 days", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app);
  expect((await dav(app, minted, "PUT", "note.txt", "keep the hash")).status).toBe(201);
  expect(app.repo.objects.length).toBe(1);
  app.clock.t += DRIVE_TTL_MS + 1;
  expect((await dav(app, minted, "GET", "note.txt")).status).toBe(401);
  expect((await app.bucket.list()).objects.length).toBe(0);
  expect(app.repo.drives[0]?.status).toBe("wiped");
  expect(app.repo.objects.length).toBe(1);
  app.repo.blocks.push({ kind: "email", hmac: "kept", reason: "report", createdAt: app.clock.t });
  app.clock.t += 30 * 24 * 60 * 60 * 1000 + 1;
  await app.sweep();
  expect(app.repo.drives.length).toBe(0);
  expect(app.repo.objects.length).toBe(0);
  expect(app.repo.blocks.length).toBe(1);
});
