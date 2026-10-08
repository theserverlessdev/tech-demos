import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { userForEmail } from "../src/access";
import { asAdmin, call, createAgent, panel, signAccess } from "./helpers";

describe("access and keys", () => {
  it("rejects a missing, bad, or mismatched Access token", async () => {
    const missing = await call("/admin/mail", { headers: { accept: "application/json" } });
    expect(missing.status).toBe(403);
    expect((missing.body as { error: { code: string } }).error.code).toBe("access");

    const garbage = await call("/admin/mail", { headers: panel(`${await signAccess(env.ADMIN_EMAIL)}x`) });
    expect(garbage.status).toBe(403);

    const aud = await call("/admin/mail", { headers: panel(await signAccess(env.ADMIN_EMAIL, { aud: "other-aud" })) });
    expect(aud.status).toBe(403);

    const iss = await call("/admin/mail", {
      headers: panel(await signAccess(env.ADMIN_EMAIL, { iss: "https://evil.example" })),
    });
    expect(iss.status).toBe(403);

    const stranger = await call("/admin/mail", { headers: panel(await signAccess("stranger@example.com")) });
    expect(stranger.status).toBe(403);
    expect((stranger.body as { error: { code: string } }).error.code).toBe("not_invited");
  });

  it("bootstraps the admin from ADMIN_EMAIL and keeps other users out", async () => {
    expect(env.ADMIN_EMAIL.includes("@")).toBe(true);
    const token = await asAdmin();
    const row = await env.DB.prepare("SELECT email, role FROM users").first<{ email: string; role: string }>();
    expect(row?.email).toBe(env.ADMIN_EMAIL.trim().toLowerCase());
    expect(row?.role).toBe("admin");

    const health = await call("/health");
    expect(health.status).toBe(200);
    expect(health.text.includes(env.ADMIN_EMAIL)).toBe(false);

    const invited = await call("/admin/users", {
      method: "POST",
      headers: panel(token),
      body: JSON.stringify({ email: "mate@example.com", role: "user" }),
    });
    expect(invited.status).toBe(200);
    const mate = await signAccess("mate@example.com");
    const denied = await call("/admin/users", {
      method: "POST",
      headers: panel(mate),
      body: JSON.stringify({ email: "other@example.com", role: "user" }),
    });
    expect(denied.status).toBe(403);
    expect((denied.body as { error: { code: string } }).error.code).toBe("forbidden");

    const agentId = await createAgent(token, { name: "private", policy: "draft", dailySendCap: 5 });
    const hidden = await call(`/admin/agents/${agentId}`, { headers: panel(mate, false) });
    expect(hidden.status).toBe(404);
    const list = await call("/admin/agents", { headers: panel(mate, false) });
    expect(list.text.includes("private")).toBe(false);

    const nobody = await userForEmail(
      new Proxy(env, {
        get(target, prop, receiver) {
          if (prop === "ADMIN_EMAIL") return "";
          return Reflect.get(target, prop, receiver);
        },
      }) as Env,
      "newcomer@example.com",
    );
    expect(nobody).toBeNull();
  });

  it("requires a live key and scopes it to the agent inboxes", async () => {
    const token = await asAdmin();
    const ownerId = await createAgent(token, { name: "owner", policy: "draft", dailySendCap: 5 });
    const otherId = await createAgent(token, { name: "other", policy: "draft", dailySendCap: 5 });
    const ownerKey = await mint(token, ownerId);
    const otherInbox = await createInbox(token, otherId);
    const ownInbox = await createInbox(token, ownerId);

    const open = await call("/v1/openapi.json");
    expect(open.status).toBe(200);
    expect((open.body as { openapi: string }).openapi).toBe("3.1.0");

    const none = await call("/v1/me");
    expect(none.status).toBe(401);
    const bad = await call("/v1/me", { headers: { authorization: "Bearer am1_not-a-real-key" } });
    expect(bad.status).toBe(401);

    const me = await call("/v1/me", { headers: { authorization: `Bearer ${ownerKey.key}` } });
    expect(me.status).toBe(200);
    expect((me.body as { agent: { id: string } }).agent.id).toBe(ownerId);

    const foreign = await call(`/v1/inboxes/${otherInbox.id}`, { headers: { authorization: `Bearer ${ownerKey.key}` } });
    expect(foreign.status).toBe(404);
    const own = await call(`/v1/inboxes/${ownInbox.id}`, { headers: { authorization: `Bearer ${ownerKey.key}` } });
    expect(own.status).toBe(200);

    const revoked = await call(`/admin/agents/${ownerId}/keys/${ownerKey.id}/revoke`, {
      method: "POST",
      headers: panel(token),
      body: "{}",
    });
    expect(revoked.status).toBe(200);
    const after = await call("/v1/me", { headers: { authorization: `Bearer ${ownerKey.key}` } });
    expect(after.status).toBe(401);
  });
});

async function mint(token: string, agentId: string): Promise<{ id: string; key: string }> {
  const minted = await call(`/admin/agents/${agentId}/keys`, {
    method: "POST",
    headers: panel(token),
    body: JSON.stringify({ name: "ci" }),
  });
  const body = minted.body as { id: string; key: string };
  return { id: body.id, key: body.key };
}

async function createInbox(token: string, agentId: string): Promise<{ id: string }> {
  const localPart = `box${agentId.slice(0, 8)}`;
  const created = await call(`/admin/agents/${agentId}/inboxes`, {
    method: "POST",
    headers: panel(token),
    body: JSON.stringify({ localPart }),
  });
  return { id: (created.body as { id: string }).id };
}
