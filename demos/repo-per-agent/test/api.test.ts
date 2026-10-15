import { afterEach, describe, expect, test } from "bun:test";
import { AgentBusyError, AgentBudgetError } from "../src/worker/run";
import { cleanupExpired, httpFromRunError, HttpError } from "../src/worker/api";
import { utcDay } from "../src/worker/db";
import { verifyTurnstile } from "../src/worker/turnstile";
import { api, DUMMY, makeHarness, visitorCookie, type Harness } from "./harness";

let harness: Harness | undefined;

afterEach(() => {
  harness?.stop();
  harness = undefined;
});

describe("health and cookies", () => {
  test("health is rate-limited, checks D1 only, and omits turnstile", async () => {
    harness = await makeHarness();
    const before = harness.artifacts.calls.length;
    const res = await api(harness.env, "/api/health");
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ ok: true });
    expect((res.data as { turnstile?: boolean }).turnstile).toBeUndefined();
    expect(harness.artifacts.calls.length).toBe(before);
  });

  test("a malformed cookie does not 500", async () => {
    harness = await makeHarness();
    const res = await api(harness.env, "/api/session", { cookie: "rpa_vid=%E0%A4%A" });
    expect(res.status).toBe(200);
    expect(res.cookie).toContain("rpa_vid=");
  });

  test("a malformed task id is 404 not 500", async () => {
    harness = await makeHarness();
    const res = await api(harness.env, "/api/tasks/%E0%A4%A", { cookie: visitorCookie() });
    expect(res.status).toBe(404);
  });

  test("content-length over the limit is rejected before parse", async () => {
    harness = await makeHarness();
    const res = await api(harness.env, "/api/tasks", {
      method: "POST",
      cookie: visitorCookie(),
      origin: "http://127.0.0.1:8787",
      body: { title: "x" },
      contentLength: "9000",
    });
    expect(res.status).toBe(413);
  });
});

describe("caps and cleanup", () => {
  test("visitor cap is atomic", async () => {
    harness = await makeHarness({ maxTasks: "2", maxLive: "10" });
    const cookie = visitorCookie();
    const a = await api(harness.env, "/api/tasks", {
      method: "POST",
      cookie,
      origin: harness.origin,
      body: { title: "one", turnstileToken: DUMMY },
    });
    const b = await api(harness.env, "/api/tasks", {
      method: "POST",
      cookie,
      origin: harness.origin,
      body: { title: "two", turnstileToken: DUMMY },
    });
    const c = await api(harness.env, "/api/tasks", {
      method: "POST",
      cookie,
      origin: harness.origin,
      body: { title: "three", turnstileToken: DUMMY },
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(c.status).toBe(429);
    expect((c.data as { error?: { code?: string } }).error?.code).toBe("repo_cap");
  }, 20000);

  test("global live ceiling is enforced", async () => {
    harness = await makeHarness({ maxTasks: "5", maxLive: "1" });
    const first = await api(harness.env, "/api/tasks", {
      method: "POST",
      cookie: visitorCookie("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      origin: harness.origin,
      body: { title: "one", turnstileToken: DUMMY },
    });
    const second = await api(harness.env, "/api/tasks", {
      method: "POST",
      cookie: visitorCookie("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
      origin: harness.origin,
      body: { title: "two", turnstileToken: DUMMY },
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
    expect((second.data as { error?: { message?: string } }).error?.message).toContain("ceiling");
  }, 20000);

  test("cleanup deletes the repo and backs off a failing delete", async () => {
    harness = await makeHarness();
    const cookie = visitorCookie();
    const created = await api(harness.env, "/api/tasks", {
      method: "POST",
      cookie,
      origin: harness.origin,
      body: { title: "expire me", turnstileToken: DUMMY },
    });
    const id = (created.data as { id: string }).id;
    await harness.env.DB.prepare("UPDATE tasks SET expires_at = 1 WHERE id = ?").bind(id).run();
    const first = await cleanupExpired(harness.env);
    expect(first.deleted).toBe(1);
    expect(harness.artifacts.calls.some((call) => call.method === "delete" && call.repo === id)).toBe(true);
    const gone = await api(harness.env, `/api/tasks/${id}`, { cookie });
    expect(gone.status).toBe(404);

    await harness.env.DB.prepare(
      "INSERT INTO tasks (id, visitor_id, repo_name, title, remote, created_at, expires_at, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
    )
      .bind("task-ffffffffffffffff", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "missing-repo", "x", "", 1, 1)
      .run();
    const original = harness.env.ARTIFACTS.delete.bind(harness.env.ARTIFACTS);
    harness.env.ARTIFACTS.delete = async () => {
      throw new Error("boom");
    };
    const failed = await cleanupExpired(harness.env);
    expect(failed.failed).toBe(1);
    const row = await harness.env.DB.prepare("SELECT attempts, expires_at, next_attempt_at FROM tasks WHERE id = ?")
      .bind("task-ffffffffffffffff")
      .first<{ attempts: number; expires_at: number; next_attempt_at: number }>();
    expect(row?.attempts).toBe(1);
    expect(row?.expires_at).toBe(1);
    expect(row?.next_attempt_at ?? 0).toBeGreaterThan(Date.now());
    const listed = await api(harness.env, "/api/session", { cookie: visitorCookie("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") });
    expect((listed.data as { tasks: { id: string }[] }).tasks.some((task) => task.id === "task-ffffffffffffffff")).toBe(false);
    const skipped = await cleanupExpired(harness.env);
    expect(skipped.failed).toBe(0);
    expect(skipped.deleted).toBe(0);
    harness.env.ARTIFACTS.delete = original;
  }, 20000);

  test("a failed seed keeps the D1 row when repo delete fails", async () => {
    harness = await makeHarness();
    const originalCreate = harness.env.ARTIFACTS.create.bind(harness.env.ARTIFACTS);
    const originalDelete = harness.env.ARTIFACTS.delete.bind(harness.env.ARTIFACTS);
    harness.env.ARTIFACTS.create = async (name) => {
      const created = await originalCreate(name);
      return { ...created, token: "bad" };
    };
    harness.env.ARTIFACTS.delete = async () => {
      throw new Error("cannot delete");
    };
    const res = await api(harness.env, "/api/tasks", {
      method: "POST",
      cookie: visitorCookie(),
      origin: harness.origin,
      body: { title: "orphan", turnstileToken: DUMMY },
    });
    expect(res.status).toBe(503);
    const row = await harness.env.DB.prepare("SELECT id, expires_at, next_attempt_at FROM tasks LIMIT 1").first<{
      id: string;
      expires_at: number;
      next_attempt_at: number;
    }>();
    expect(row).toBeTruthy();
    expect(row?.expires_at).toBe(0);
    expect(row?.next_attempt_at).toBe(0);
    harness.env.ARTIFACTS.delete = originalDelete;
    const cleaned = await cleanupExpired(harness.env);
    expect(cleaned.deleted).toBe(1);
    expect(await harness.env.DB.prepare("SELECT id FROM tasks LIMIT 1").first()).toBeNull();
  }, 20000);

  test("a failed seed deletes the D1 row when the repo is gone", async () => {
    harness = await makeHarness();
    const originalCreate = harness.env.ARTIFACTS.create.bind(harness.env.ARTIFACTS);
    harness.env.ARTIFACTS.create = async (name) => {
      const created = await originalCreate(name);
      return { ...created, token: "bad" };
    };
    const res = await api(harness.env, "/api/tasks", {
      method: "POST",
      cookie: visitorCookie(),
      origin: harness.origin,
      body: { title: "gone", turnstileToken: DUMMY },
    });
    expect(res.status).toBe(503);
    const row = await harness.env.DB.prepare("SELECT id FROM tasks LIMIT 1").first();
    expect(row).toBeNull();
  }, 20000);

  test("daily AI cap is enforced", async () => {
    harness = await makeHarness({ aiCap: "1" });
    const cookie = visitorCookie();
    const created = await api(harness.env, "/api/tasks", {
      method: "POST",
      cookie,
      origin: harness.origin,
      body: { title: "budget", turnstileToken: DUMMY },
    });
    const id = (created.data as { id: string }).id;
    const ok = await api(harness.env, `/api/tasks/${id}/run`, {
      method: "POST",
      cookie,
      origin: harness.origin,
      body: { instruction: "Add reverse", turnstileToken: DUMMY },
    });
    expect(ok.status).toBe(200);
    const blocked = await api(harness.env, `/api/tasks/${id}/run`, {
      method: "POST",
      cookie,
      origin: harness.origin,
      body: { instruction: "Add reverse again", turnstileToken: DUMMY },
    });
    expect(blocked.status).toBe(429);
    expect((blocked.data as { error?: { code?: string } }).error?.code).toBe("ai_budget");
    expect(utcDay(Date.now()).length).toBe(10);
  }, 20000);
});

describe("errors", () => {
  test("a busy agent is 409", () => {
    const err = httpFromRunError("task-1", new AgentBusyError());
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("agent_busy");
  });

  test("a spent AI budget is 429", () => {
    const err = httpFromRunError("task-1", new AgentBudgetError());
    expect(err.status).toBe(429);
    expect(err.code).toBe("ai_budget");
  });

  test("a plain Error with code maps after Durable Object RPC", () => {
    const busy = Object.assign(new Error("This agent is already writing a commit."), { code: "agent_busy" });
    const budget = Object.assign(new Error("The shared Workers AI budget for today is used up. Try again tomorrow."), {
      code: "ai_budget",
    });
    const mappedBusy = httpFromRunError("task-1", busy);
    expect(mappedBusy).toBeInstanceOf(HttpError);
    expect(mappedBusy.status).toBe(409);
    expect(mappedBusy.code).toBe("agent_busy");
    const mappedBudget = httpFromRunError("task-1", budget);
    expect(mappedBudget.status).toBe(429);
    expect(mappedBudget.code).toBe("ai_budget");
  });

  test("unknown API paths are 404", async () => {
    harness = await makeHarness();
    const res = await api(harness.env, "/api/nope");
    expect(res.status).toBe(404);
  });
});

describe("turnstile hosts", () => {
  test("test hostnames only pass with the always-pass secret", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = async () =>
      Response.json({ success: true, hostname: "example.com", action: "create-task" }) as Promise<Response>;
    try {
      const test = await verifyTurnstile(
        { TURNSTILE_SECRET: "1x0000000000000000000000000000000AA", TURNSTILE_SITE_KEY: "1x00000000000000000000AA" } as never,
        "tok",
        "1.1.1.1",
        "create-task",
      );
      const prod = await verifyTurnstile(
        { TURNSTILE_SECRET: "0xprodsecret", TURNSTILE_SITE_KEY: "0xsite" } as never,
        "tok",
        "1.1.1.1",
        "create-task",
      );
      expect(test).toBe(true);
      expect(prod).toBe(false);
    } finally {
      globalThis.fetch = real;
    }
  });
});
