import { afterEach, describe, expect, test } from "bun:test";
import { api, DUMMY, makeHarness, visitorCookie, type Harness } from "./harness";

let harness: Harness | undefined;

afterEach(() => {
  harness?.stop();
  harness = undefined;
});

describe("Workers AI writes the commit", () => {
  test("create → run → diff uses the model edit and a real receive-pack", async () => {
    harness = await makeHarness();
    const cookie = visitorCookie();
    const created = await api(harness.env, "/api/tasks", {
      method: "POST",
      cookie,
      origin: harness.origin,
      body: { title: "Smoke greeting", turnstileToken: DUMMY },
    });
    expect(created.status).toBe(201);
    const id = (created.data as { id: string; seed: string; remote: string }).id;
    expect(id.startsWith("task-")).toBe(true);
    expect((created.data as { remote: string }).remote).toContain("127.0.0.1");
    expect((created.data as { seed: string }).seed).toMatch(/^[0-9a-f]{40}$/);

    const detail = await api(harness.env, `/api/tasks/${id}`, { cookie });
    expect(detail.status).toBe(200);
    const commits = (detail.data as { commits: { hash: string; message: string }[] }).commits;
    expect(commits.some((commit) => commit.message.includes("Seed"))).toBe(true);

    const run = await api(harness.env, `/api/tasks/${id}/run`, {
      method: "POST",
      cookie,
      origin: harness.origin,
      body: {
        instruction: "Add a reverse function to src/task.ts",
        turnstileToken: DUMMY,
      },
    });
    expect(run.status).toBe(200);
    const result = run.data as { hash: string; path: string; message: string };
    expect(result.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.path).toBe("src/task.ts");
    expect(result.message).toBe("Add reverse helper");
    expect(harness.ai.calls).toBe(1);
    const input = harness.ai.lastInput as { reasoning_effort?: string; max_tokens?: number; response_format?: { type?: string } };
    expect(input.reasoning_effort).toBe("low");
    expect(input.max_tokens).toBe(4096);
    expect(input.response_format?.type).toBe("json_schema");

    const again = await api(harness.env, `/api/tasks/${id}`, { cookie });
    const after = (again.data as { commits: { hash: string; message: string }[]; agent?: { runs: number } }).commits;
    expect(after.some((commit) => commit.hash === result.hash)).toBe(true);
    expect((again.data as { agent?: { runs: number } }).agent?.runs).toBe(1);

    const beforeDetail = harness.artifacts.calls.length;
    const diff = await api(harness.env, `/api/tasks/${id}/commits/${result.hash}`, { cookie });
    expect(diff.status).toBe(200);
    const files = (diff.data as { files: { path: string; status: string; patch: string }[] }).files;
    const file = files.find((item) => item.path === "src/task.ts");
    expect(file?.status).toBe("modified");
    expect(file?.patch).toContain("+export function reverse");
    expect(file?.patch.startsWith("@@")).toBe(false);

    const detailCalls = harness.artifacts.calls.slice(beforeDetail);
    expect(detailCalls.filter((call) => call.method === "log" || call.method === "readFile").length).toBe(0);
    expect(detailCalls.some((call) => call.method === "readBlob")).toBe(true);
    const afterFirst = harness.artifacts.calls.length;
    const cached = await api(harness.env, `/api/tasks/${id}/commits/${result.hash}`, { cookie });
    expect(cached.status).toBe(200);
    expect(harness.artifacts.calls.length).toBe(afterFirst);

    const token = await api(harness.env, `/api/tasks/${id}/token`, { method: "POST", cookie, origin: harness.origin, body: {} });
    expect(token.status).toBe(200);
    const minted = token.data as { token: string; remote: string; expiresAt: string; ttlSeconds: number };
    expect(minted.token.startsWith("art_")).toBe(true);
    expect(minted.token).toContain("expires=");
    expect(minted.ttlSeconds).toBeGreaterThan(500);
    expect(minted.ttlSeconds).toBeLessThanOrEqual(600);
    const exp = Number(new URLSearchParams(minted.token.split("?")[1]).get("expires"));
    expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000) + 500);

    const push = await fetch(`${minted.remote}/git-receive-pack`, {
      method: "POST",
      headers: { authorization: `Bearer ${minted.token}` },
      body: new Uint8Array([0]),
    });
    expect(push.status).toBe(403);
  }, 20000);
});
