import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { handleApi, HttpError } from "../src/worker/api";
import { finishJudgment, insertJudgment, insertMedia } from "../src/worker/db";
import type { JudgmentResult } from "../src/shared/types";

const OWNER = "a".repeat(32);
const OTHER = "b".repeat(32);
const MEDIA = "c".repeat(32);
const JUDGMENT = "d".repeat(32);
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0));

function memoryDb(): Database {
  const db = new Database(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../migrations/0002_pair.sql", import.meta.url), "utf8"));
  return db;
}

function asD1(db: Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          statement.args = args;
          return statement;
        },
        async run() {
          const info = db.query(sql).run(...(statement.args as never[]));
          return { success: true, meta: { changes: info.changes } };
        },
        async first<T>() {
          return (db.query(sql).get(...(statement.args as never[])) as T | null) ?? null;
        },
        async all<T>() {
          return { results: db.query(sql).all(...(statement.args as never[])) as T[] };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function apiEnv(db: Database, objects: Map<string, Uint8Array>): Env {
  return {
    DB: asD1(db),
    ENVIRONMENT: "local",
    IP_HASH_SECRET: "test-ip-secret",
    TURNSTILE_SECRET: "secret",
    TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    OMNI_MODEL: "@cf/cloudflare/clef-omni",
    CLEF_MODEL: "@cf/cloudflare/clef",
    WHISPER_MODEL: "@cf/openai/whisper-large-v3-turbo",
    VISION_MODEL: "@cf/meta/llama-3.2-11b-vision-instruct",
    READ_LIMIT: { limit: async () => ({ success: true }) },
    JUDGE_LIMIT: { limit: async () => ({ success: true }) },
    COMPARE_LIMIT: { limit: async () => ({ success: true }) },
    BUCKET: {
      get: async (key: string, options?: { range?: Headers }) => {
        const stored = objects.get(key);
        if (!stored) return null;
        const header = options?.range instanceof Headers ? options.range.get("range") : null;
        let offset = 0;
        let length = stored.length;
        if (header?.startsWith("bytes=")) {
          const [startRaw, endRaw] = header.slice(6).split("-");
          offset = Number(startRaw || 0);
          const end = endRaw ? Number(endRaw) : stored.length - 1;
          length = end - offset + 1;
        }
        const slice = stored.subarray(offset, offset + length);
        return {
          size: stored.length,
          httpEtag: '"etag"',
          range: header ? { offset, length: slice.length } : undefined,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(slice);
              controller.close();
            },
          }),
        };
      },
      delete: async (key: string) => {
        objects.delete(key);
      },
      put: async (key: string, value: Uint8Array) => {
        objects.set(key, value);
      },
    },
  } as unknown as Env;
}

async function call(env: Env, path: string, cookie: string): Promise<Response> {
  try {
    return await handleApi(new Request(`http://127.0.0.1${path}`, { headers: { cookie: `__Host-oj_vid=${cookie}` } }), env, path);
  } catch (err) {
    if (err instanceof HttpError) {
      return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status });
    }
    throw err;
  }
}

describe("owner-only access", () => {
  test("a different visitor gets 404 for the file and the judgment", async () => {
    const db = memoryDb();
    const objects = new Map<string, Uint8Array>([["media/" + MEDIA, PNG]]);
    const env = apiEnv(db, objects);
    const now = Date.now();
    await insertMedia(env, {
      id: MEDIA,
      visitor_id: OWNER,
      kind: "image",
      content_type: "image/png",
      bytes: PNG.length,
      duration_ms: null,
      r2_key: `media/${MEDIA}`,
      now,
    });
    expect(
      await insertJudgment(env, {
        id: JUDGMENT,
        visitorId: OWNER,
        mediaId: MEDIA,
        sampleId: null,
        pairId: "pair-1",
        kind: "omni",
        modality: "image",
        label: "Upload",
        ipKey: "hashed",
        questionsJson: "[]",
        now,
      }),
    ).toBe(true);
    const result: JudgmentResult = {
      answers: [],
      latencyMs: 12,
      model: "@cf/cloudflare/clef-omni",
      source: "local-stub",
      cost: { usd: null, note: "Local stub. Workers AI was not called." },
      untrustedText: null,
      steps: [],
    };
    await finishJudgment(env, JUDGMENT, result, null);

    const ownFile = await call(env, `/api/media/${MEDIA}`, OWNER);
    expect(ownFile.status).toBe(200);
    expect(ownFile.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(ownFile.headers.get("x-robots-tag")).toBe("noindex");
    expect(ownFile.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(ownFile.headers.get("content-type")).toBe("image/png");

    const foreignFile = await call(env, `/api/media/${MEDIA}`, OTHER);
    expect(foreignFile.status).toBe(404);
    const foreignFileBody = (await foreignFile.json()) as { error?: { message?: string } };
    expect(foreignFileBody.error?.message).toBe("That file does not exist.");

    const own = await call(env, `/api/judgments/${JUDGMENT}`, OWNER);
    expect(own.status).toBe(200);
    const foreign = await call(env, `/api/judgments/${JUDGMENT}`, OTHER);
    expect(foreign.status).toBe(404);
    const foreignBody = (await foreign.json()) as { error?: { message?: string } };
    expect(foreignBody.error?.message).toBe("That judgment does not exist.");
    const ownBody = (await own.json()) as { pairId?: string };
    expect(ownBody.pairId).toBe("pair-1");
  });

  test("a byte range is streamed with the stored type and an expired file is hidden", async () => {
    const db = memoryDb();
    const objects = new Map<string, Uint8Array>([["media/" + MEDIA, PNG]]);
    const env = apiEnv(db, objects);
    const now = Date.now();
    await insertMedia(env, {
      id: MEDIA,
      visitor_id: OWNER,
      kind: "image",
      content_type: "image/png",
      bytes: PNG.length,
      duration_ms: null,
      r2_key: `media/${MEDIA}`,
      now,
    });
    const ranged = await handleApi(
      new Request(`http://127.0.0.1/api/media/${MEDIA}`, { headers: { cookie: `__Host-oj_vid=${OWNER}`, range: "bytes=0-3" } }),
      env,
      `/api/media/${MEDIA}`,
    );
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-type")).toBe("image/png");
    expect(ranged.headers.get("accept-ranges")).toBe("bytes");
    expect(ranged.headers.get("content-range")).toBe(`bytes 0-3/${PNG.length}`);
    const body = new Uint8Array(await ranged.arrayBuffer());
    expect([...body]).toEqual([...PNG.subarray(0, 4)]);

    const expiredId = "e".repeat(32);
    objects.set(`media/${expiredId}`, PNG);
    await insertMedia(env, {
      id: expiredId,
      visitor_id: OWNER,
      kind: "image",
      content_type: "image/png",
      bytes: PNG.length,
      duration_ms: null,
      r2_key: `media/${expiredId}`,
      now: now - 25 * 60 * 60 * 1000,
    });
    const expired = await call(env, `/api/media/${expiredId}`, OWNER);
    expect(expired.status).toBe(404);
    const oldJudgment = "f".repeat(32);
    expect(
      await insertJudgment(env, {
        id: oldJudgment,
        visitorId: OWNER,
        mediaId: null,
        sampleId: null,
        pairId: "old",
        kind: "omni",
        modality: "image",
        label: "Old",
        ipKey: "hashed",
        questionsJson: "[]",
        now: now - 25 * 60 * 60 * 1000,
      }),
    ).toBe(true);
    const listed = await call(env, "/api/judgments", OWNER);
    const list = (await listed.json()) as { judgments: { id: string }[] };
    expect(list.judgments.some((row) => row.id === oldJudgment)).toBe(false);
  });
});
