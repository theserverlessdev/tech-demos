import { Database, type SQLQueryBindings } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryBucket } from "./bucket";
import { D1Repo, MemoryRepo, type DriveRow } from "./repo";
import { wipeExpired, type Deps } from "./router";

function d1FromSqlite(database: Database): D1Database {
  return {
    prepare(query: string) {
      const statement = database.query(query);
      let bound: SQLQueryBindings[] = [];
      const prepared = {
        bind(...values: SQLQueryBindings[]) {
          bound = values;
          return prepared;
        },
        async run() {
          const result = statement.run(...bound);
          return { meta: { changes: result.changes } };
        },
        async first<T>() {
          return (statement.get(...bound) as T | null | undefined) ?? null;
        },
        async all<T>() {
          return { results: statement.all(...bound) as T[] };
        },
      };
      return prepared;
    },
  } as unknown as D1Database;
}

function drive(id: string, expiresAt: number): DriveRow {
  return {
    id,
    emailHmac: id,
    emailEnc: "enc",
    ipHmac: "ip",
    networkHmac: "net",
    createdAt: 1,
    expiresAt,
    wipedAt: null,
    frozenAt: null,
    status: "active",
    passwordHash: "hash",
    passwordSalt: "salt",
    sessionHash: null,
    bytesUsed: 0,
    fileCount: 0,
    aupVersion: "v",
  };
}

test("purge deletes more than 100 wiped drives with one json_each bind", async () => {
  const database = new Database(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");
  for (const name of ["0001_init.sql", "0002_email_daily.sql"]) database.exec(readFileSync(join(dir, name), "utf8"));
  const insertDrive = database.query(
    `INSERT INTO drives (
      id, email_hmac, email_enc, ip_hmac, network_hmac, created_at, expires_at,
      status, password_hash, password_salt, bytes_used, file_count, aup_version, wiped_at
    ) VALUES (?1, ?2, 'enc', 'ip', 'net', 1, 2, 'wiped', 'h', 's', 0, 0, 'v', ?3)`,
  );
  const insertObject = database.query("INSERT INTO objects (drive_id, key, sha256, size, first_seen) VALUES (?1, 'a', 'ab', 1, 1)");
  const before = 1_000_000;
  const write = database.transaction(() => {
    for (let i = 0; i < 120; i++) {
      insertDrive.run(`old-${i}`, `old-${i}`, before - 1);
      insertObject.run(`old-${i}`);
    }
    insertDrive.run("recent", "recent", before);
    insertObject.run("recent");
  });
  write();
  await new D1Repo(d1FromSqlite(database)).purge(before);
  expect(database.query("SELECT COUNT(*) AS n FROM drives").get()).toEqual({ n: 1 });
  expect(database.query("SELECT id FROM drives").get()).toEqual({ id: "recent" });
  expect(database.query("SELECT COUNT(*) AS n FROM objects").get()).toEqual({ n: 1 });
});

test("one failing wipe still wipes the next drive and purges", async () => {
  const repo = new MemoryRepo();
  const now = Date.parse("2026-11-10T12:00:00Z");
  await repo.insertDrive(drive("bad", now - 1));
  await repo.insertDrive(drive("good", now - 2));
  await repo.insertDrive({ ...drive("old", 1), status: "wiped", wipedAt: now - 40 * 24 * 60 * 60 * 1000 });
  const deps = {
    repo,
    bucket: new MemoryBucket(),
    now: () => now,
    locksFor: (id: string) => ({
      async list() {
        return [];
      },
      async wipe() {
        if (id === "bad") throw new Error("wipe");
      },
    }),
  } as unknown as Deps;
  expect(await wipeExpired(deps)).toBe(1);
  expect((await repo.getDrive("good"))?.status).toBe("wiped");
  expect((await repo.getDrive("bad"))?.status).toBe("active");
  expect(await repo.getDrive("old")).toBeNull();
});
