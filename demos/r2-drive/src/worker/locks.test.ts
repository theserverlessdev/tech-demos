import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MemoryBucket } from "./bucket";
import { DriveSession } from "./drive-session";
import { SqliteLocks } from "./locks";
import { bunSql } from "./sqlite-bun";
import type { SqlRunner } from "./quota";
import { authHeaders, createTestApp, davUrl, mintDrive } from "./test-app";

const ORIGIN = "http://127.0.0.1:8808";
const shared = `<?xml version="1.0"?><lockinfo xmlns="DAV:"><lockscope><shared/></lockscope><locktype><write/></locktype><owner>ada</owner></lockinfo>`;
const exclusive = `<?xml version="1.0"?><lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope><locktype><write/></locktype></lockinfo>`;

test("sqlite locks cap shared locks and write one row", async () => {
  const database = new Database(":memory:");
  const inner = bunSql(database);
  const writes: string[] = [];
  const sql: SqlRunner = {
    exec(query, ...bindings) {
      if (/^\s*(insert|update|delete)\b/i.test(query)) writes.push(query);
      return inner.exec(query, ...bindings);
    },
  };
  const locks = new SqliteLocks(sql);
  const session = new DriveSession({
    sql,
    bucket: new MemoryBucket(),
    locks,
    audit: async () => undefined,
  });
  const put = await session.handle(request("PUT", "a.txt", "a"), "/dav/x", "a.txt", () => 1, 60_000);
  expect(put.status).toBe(201);
  let created = 0;
  for (let index = 0; index < 20; index++) {
    writes.length = 0;
    const response = await session.handle(request("LOCK", "a.txt", shared), "/dav/x", "a.txt", () => 1, 60_000);
    if (response.status === 201) {
      created += 1;
      if (created === 8) expect(writes.length).toBeLessThanOrEqual(3);
    } else {
      expect(response.status).toBe(423);
    }
  }
  expect(created).toBe(8);
  expect((await locks.list(1)).length).toBe(8);
  const fat = shared.replace("<owner>ada</owner>", `<owner>${"x".repeat(2048)}</owner>`);
  const rejected = await session.handle(request("LOCK", "a.txt", fat), "/dav/x", "a.txt", () => 1, 60_000);
  expect(rejected.status).toBe(400);
});

test("the lock list never grows past 64", async () => {
  const app = await createTestApp();
  const minted = await mintDrive(app);
  for (let index = 0; index < 64; index++) {
    const put = await app.fetch(davUrl(minted.driveId, `n${index}.txt`), {
      method: "PUT",
      headers: authHeaders(minted),
      body: "x",
    });
    expect(put.status).toBe(201);
    const locked = await app.fetch(davUrl(minted.driveId, `n${index}.txt`), {
      method: "LOCK",
      headers: authHeaders(minted, { "content-type": "application/xml" }),
      body: exclusive,
    });
    expect(locked.status).toBe(201);
  }
  const listed = await app.fetch(`${ORIGIN}/api/locks`, { headers: { cookie: minted.cookie } });
  const body = (await listed.json()) as { locks: unknown[] };
  expect(body.locks.length).toBe(64);
  const extraPut = await app.fetch(davUrl(minted.driveId, "extra.txt"), {
    method: "PUT",
    headers: authHeaders(minted),
    body: "x",
  });
  expect(extraPut.status).toBe(201);
  const extra = await app.fetch(davUrl(minted.driveId, "extra.txt"), {
    method: "LOCK",
    headers: authHeaders(minted, { "content-type": "application/xml" }),
    body: exclusive,
  });
  expect(extra.status).toBe(423);
  const again = await app.fetch(`${ORIGIN}/api/locks`, { headers: { cookie: minted.cookie } });
  expect(((await again.json()) as { locks: unknown[] }).locks.length).toBe(64);
});

test("sqlite locks stop at 64 on one drive", async () => {
  const database = new Database(":memory:");
  const sql = bunSql(database);
  const locks = new SqliteLocks(sql);
  const session = new DriveSession({
    sql,
    bucket: new MemoryBucket(),
    locks,
    audit: async () => undefined,
  });
  for (let index = 0; index < 64; index++) {
    const put = await session.handle(request("PUT", `n${index}.txt`, "x"), "/dav/x", `n${index}.txt`, () => 1, 60_000);
    expect(put.status).toBe(201);
    const locked = await session.handle(request("LOCK", `n${index}.txt`, exclusive), "/dav/x", `n${index}.txt`, () => 1, 60_000);
    expect(locked.status).toBe(201);
  }
  expect((await locks.count(1))).toBe(64);
  const extraPut = await session.handle(request("PUT", "extra.txt", "x"), "/dav/x", "extra.txt", () => 1, 60_000);
  expect(extraPut.status).toBe(201);
  const extra = await session.handle(request("LOCK", "extra.txt", exclusive), "/dav/x", "extra.txt", () => 1, 60_000);
  expect(extra.status).toBe(423);
  expect((await locks.count(1))).toBe(64);
});

function request(method: string, key: string, body: string): Request {
  return new Request(`http://127.0.0.1/dav/x/${key}`, { method, body, headers: { "content-type": "application/xml" } });
}
