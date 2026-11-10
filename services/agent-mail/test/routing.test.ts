import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { setRoutingFetchForTests } from "../src/routing";
import { asAdmin, call, createAgent, createInbox, panel } from "./helpers";

const ZONE = "0123456789abcdef0123456789abcdef";
const TOKEN = "routing-test-token";

type Captured = {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
  authorization: string | null;
};

function install(mode: "ok" | "fail" | "delete-fail"): Captured[] {
  const calls: Captured[] = [];
  setRoutingFetchForTests(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const raw = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      url,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
      authorization: headers.get("authorization"),
    });
    if (mode === "fail" || (mode === "delete-fail" && method === "DELETE")) {
      return Response.json({ success: false, errors: [{ message: "zone not found" }] }, { status: 400 });
    }
    const id = method === "POST" ? "rule-created" : url.split("/").pop();
    return Response.json({ success: true, errors: [], result: { id } });
  }, env);
  return calls;
}

function armRouting(): void {
  env.CF_ROUTING_TOKEN = TOKEN;
  env.CF_ZONE_ID = ZONE;
  env.ROUTING_WORKER_NAME = "agent-mail";
}

afterEach(() => {
  setRoutingFetchForTests(null, env);
  env.CF_ROUTING_TOKEN = "";
  env.CF_ZONE_ID = "replace-with-zone-id";
  env.ROUTING_WORKER_NAME = "agent-mail";
});

describe.sequential("email routing rules", () => {
  it("creates the inbox when the token is unset and shows the missing rule", async () => {
    env.CF_ROUTING_TOKEN = "";
    const token = await asAdmin();
    const agentId = await createAgent(token, { name: "Rescue", policy: "draft", dailySendCap: 10 });
    const created = await call(`/admin/agents/${agentId}/inboxes`, {
      method: "POST",
      headers: panel(token),
      body: JSON.stringify({ localPart: "plain" }),
    });
    expect(created.status).toBe(200);
    const body = created.body as { routingRuleId: string | null; routingNotice: string };
    expect(body.routingRuleId).toBeNull();
    expect(body.routingNotice).toContain("routing rule missing: add it in Cloudflare");
    expect(body.routingNotice).toContain("plain@agents.theserverless.dev -> worker agent-mail");
    const page = await call(`/admin/agents/${agentId}`, { headers: panel(token) });
    expect(page.text).toContain("routing rule missing: add it in Cloudflare");
    expect(page.text).toContain("plain@agents.theserverless.dev -&gt; worker agent-mail");
  });

  it("posts a literal worker rule and stores the id", async () => {
    armRouting();
    const calls = install("ok");
    const token = await asAdmin();
    const agentId = await createAgent(token, { name: "Rescue", policy: "draft", dailySendCap: 10 });
    const inbox = await createInbox(token, agentId, "literal");
    const row = await env.DB.prepare("SELECT routing_rule_id FROM inboxes WHERE id = ?").bind(inbox.id).first<{ routing_rule_id: string }>();
    expect(row?.routing_rule_id).toBe("rule-created");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `https://api.cloudflare.com/client/v4/zones/${ZONE}/email/routing/rules`,
      authorization: `Bearer ${TOKEN}`,
      body: {
        name: "literal@agents.theserverless.dev",
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: "literal@agents.theserverless.dev" }],
        actions: [{ type: "worker", value: ["agent-mail"] }],
      },
    });
  });

  it("keeps the inbox when the routing API fails", async () => {
    armRouting();
    install("fail");
    const token = await asAdmin();
    const agentId = await createAgent(token, { name: "Rescue", policy: "draft", dailySendCap: 10 });
    const created = await call(`/admin/agents/${agentId}/inboxes`, {
      method: "POST",
      headers: panel(token),
      body: JSON.stringify({ localPart: "failed" }),
    });
    expect(created.status).toBe(200);
    const body = created.body as { id: string; routingNotice: string };
    expect(body.routingNotice).toContain("routing rule missing: add it in Cloudflare");
    const row = await env.DB.prepare("SELECT routing_rule_id FROM inboxes WHERE id = ?").bind(body.id).first<{ routing_rule_id: string | null }>();
    expect(row?.routing_rule_id).toBeNull();
  });

  it("disables the rule, then deletes it with the empty inbox", async () => {
    armRouting();
    const calls = install("ok");
    const token = await asAdmin();
    const agentId = await createAgent(token, { name: "Rescue", policy: "draft", dailySendCap: 10 });
    const inbox = await createInbox(token, agentId, "rescue");
    const disabled = await call(`/admin/inboxes/${inbox.id}`, {
      method: "POST",
      headers: panel(token),
      body: JSON.stringify({ status: "disabled" }),
    });
    expect(disabled.status).toBe(200);
    expect(calls[1]).toMatchObject({
      method: "PUT",
      url: `https://api.cloudflare.com/client/v4/zones/${ZONE}/email/routing/rules/rule-created`,
      body: { enabled: false, matchers: [{ type: "literal", field: "to", value: "rescue@agents.theserverless.dev" }] },
    });
    const deleted = await call(`/admin/inboxes/${inbox.id}/delete`, {
      method: "POST",
      headers: panel(token),
      body: "{}",
    });
    expect(deleted.status).toBe(200);
    expect(calls[2]?.method).toBe("DELETE");
    expect(calls[2]?.url).toBe(`https://api.cloudflare.com/client/v4/zones/${ZONE}/email/routing/rules/rule-created`);
    const row = await env.DB.prepare("SELECT id FROM inboxes WHERE id = ?").bind(inbox.id).first();
    expect(row).toBeNull();
  });

  it("leaves the inbox in place when rule deletion fails", async () => {
    armRouting();
    install("delete-fail");
    const token = await asAdmin();
    const agentId = await createAgent(token, { name: "Rescue", policy: "draft", dailySendCap: 10 });
    const inbox = await createInbox(token, agentId, "stuck");
    const deleted = await call(`/admin/inboxes/${inbox.id}/delete`, {
      method: "POST",
      headers: panel(token),
      body: "{}",
    });
    expect(deleted.status).toBe(502);
    const row = await env.DB.prepare("SELECT id FROM inboxes WHERE id = ?").bind(inbox.id).first();
    expect(row?.id).toBe(inbox.id);
  });
});
