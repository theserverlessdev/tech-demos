import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DemoEnv } from "../src/worker/env";
import { handleApi, HttpError } from "../src/worker/api";
import { MODEL_OPTIONS, type ChatOutput } from "../src/worker/ai";
import { FakeArtifacts } from "./fake-artifacts";

const SCHEMA = [
  readFileSync(join(import.meta.dir, "../migrations/0001_init.sql"), "utf8"),
  readFileSync(join(import.meta.dir, "../migrations/0002_caps.sql"), "utf8"),
].join("\n");

export const DUMMY = "XXXX.DUMMY.TOKEN.XXXX";

export function sqliteD1(sql = SCHEMA): D1Database {
  const db = new Database(":memory:");
  db.exec(sql);
  const bound = (query: string, values: unknown[]) => ({
    async first<T>() {
      const row = db.query(query).get(...(values as never[]));
      return (row as T | null) ?? null;
    },
    async all<T>() {
      return { results: db.query(query).all(...(values as never[])) as T[], success: true };
    },
    async run() {
      const result = db.run(query, ...(values as never[]));
      return { success: true, meta: { changes: Number(result.changes ?? 0) } };
    },
  });
  return {
    prepare(query: string) {
      return Object.assign(bound(query, []), {
        bind(...values: unknown[]) {
          return bound(query, values);
        },
      });
    },
  } as unknown as D1Database;
}

function allowLimit(): RateLimit {
  return { limit: async () => ({ success: true }) } as RateLimit;
}

export type ScriptedAi = {
  lastInput: unknown;
  calls: number;
  impl: (input: unknown) => ChatOutput | Promise<ChatOutput>;
};

export function scriptedAi(reply?: ChatOutput): ScriptedAi {
  const state: ScriptedAi = {
    lastInput: null,
    calls: 0,
    impl: () =>
      reply ?? {
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                path: "src/task.ts",
                content:
                  'export function hello(name: string): string {\n  return `Hello, ${name}`;\n}\n\nexport function reverse(input: string): string {\n  return [...input].reverse().join("");\n}\n',
                message: "Add reverse helper",
              }),
            },
          },
        ],
      },
  };
  return state;
}

export type Harness = {
  env: DemoEnv;
  artifacts: FakeArtifacts;
  ai: ScriptedAi;
  siteverify: { lastAction: string | null };
  origin: string;
  stop: () => void;
};

const originalFetch = globalThis.fetch;

export async function makeHarness(opts?: { ai?: ScriptedAi; maxTasks?: string; maxLive?: string; aiCap?: string }): Promise<Harness> {
  const artifacts = new FakeArtifacts();
  await artifacts.listen();
  const ai = opts?.ai ?? scriptedAi();
  const siteverify = { lastAction: null as string | null };

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.includes("challenges.cloudflare.com/turnstile/v0/siteverify")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const token = String(body.response ?? "");
      const action = token.includes("run") ? "run-agent" : "create-task";
      siteverify.lastAction = action;
      return Response.json({
        success: token === DUMMY || token.startsWith("XXXX."),
        hostname: "127.0.0.1",
        action: token === DUMMY ? undefined : action,
      });
    }
    return originalFetch(input, init);
  };

  const env = {
    AI: { run: async (_model: string, input: unknown) => {
      ai.calls += 1;
      ai.lastInput = input;
      return ai.impl(input);
    } },
    AI_MODEL: "@cf/zai-org/glm-5.3-flash",
    ARTIFACTS: artifacts,
    DB: sqliteD1(),
    CREATE_LIMIT: allowLimit(),
    RUN_LIMIT: allowLimit(),
    TOKEN_LIMIT: allowLimit(),
    READ_LIMIT: allowLimit(),
    TASK_TTL_SECONDS: "21600",
    MAX_TASKS_PER_VISITOR: opts?.maxTasks ?? "3",
    MAX_LIVE_REPOS: opts?.maxLive ?? "300",
    AI_CALLS_PER_DAY: opts?.aiCap ?? "80",
    TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
    DIRECT_RUN: "1",
    ENVIRONMENT: "local",
  } as unknown as DemoEnv;

  return {
    env,
    artifacts,
    ai,
    siteverify,
    origin: "http://127.0.0.1:8787",
    stop() {
      artifacts.stop();
      globalThis.fetch = originalFetch;
    },
  };
}

export async function api(env: DemoEnv, path: string, init?: { method?: string; body?: unknown; cookie?: string; origin?: string; ip?: string; contentLength?: string }) {
  const headers = new Headers();
  if (init?.cookie) headers.set("cookie", init.cookie);
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  if (init?.origin) headers.set("origin", init.origin);
  if (init?.ip) headers.set("cf-connecting-ip", init.ip);
  if (init?.contentLength) headers.set("content-length", init.contentLength);
  const body = init?.body !== undefined ? JSON.stringify(init.body) : undefined;
  if (body && !init?.contentLength) headers.set("content-length", String(body.length));
  const request = new Request(`http://127.0.0.1:8787${path}`, { method: init?.method ?? "GET", headers, body });
  try {
    const res = await handleApi(request, env, path);
    const text = await res.text();
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, cookie: res.headers.get("set-cookie"), text };
  } catch (err) {
    if (err instanceof HttpError) {
      return { status: err.status, data: { error: { code: err.code, message: err.message } }, cookie: null, text: err.message };
    }
    throw err;
  }
}

export function visitorCookie(id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"): string {
  return `rpa_vid=${id}`;
}

export { MODEL_OPTIONS };
