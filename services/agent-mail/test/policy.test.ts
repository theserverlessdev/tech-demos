import { describe, expect, it } from "vitest";
import { decide } from "../src/policy";
import { asAdmin, bearer, call, createAgent, createInbox, deliver, FakeMail, mintKey, rawMessage, sendMail, setAgent } from "./helpers";

describe("send policy", () => {
  it("sends immediately when the policy is auto", async () => {
    const token = await asAdmin();
    const agentId = await createAgent(token, { name: "auto", policy: "auto", dailySendCap: 10 });
    const key = await mintKey(token, agentId);
    const inbox = await createInbox(token, agentId, "auto");
    const sent = await sendMail(key, inbox.id, { to: ["ada@example.com"], subject: "Go", text: "Now" });
    expect(sent.status).toBe(201);
    expect((sent.body as { outcome: string }).outcome).toBe("sent");
  });

  it("holds a send when the policy is draft", async () => {
    const token = await asAdmin();
    const agentId = await createAgent(token, { name: "draft", policy: "draft", dailySendCap: 10 });
    const key = await mintKey(token, agentId);
    const inbox = await createInbox(token, agentId, "drafts");
    const held = await sendMail(key, inbox.id, { to: ["ada@example.com"], subject: "Wait", text: "Later" });
    expect(held.status).toBe(202);
    const body = held.body as { outcome: string; reason: string; draftId: string; statusUrl: string };
    expect(body.outcome).toBe("drafted");
    expect(body.reason).toBe("policy_draft");
    expect(body.statusUrl).toContain(`/v1/drafts/${body.draftId}`);
  });

  it("auto-sends only a reply in a thread the other party started", async () => {
    const token = await asAdmin();
    const agentId = await createAgent(token, { name: "reply", policy: "reply_only_auto", dailySendCap: 10 });
    const key = await mintKey(token, agentId);
    const inbox = await createInbox(token, agentId, "reply");
    const fresh = await sendMail(key, inbox.id, { to: ["ada@example.com"], subject: "New", text: "Hello" });
    expect((fresh.body as { outcome: string; reason: string }).outcome).toBe("drafted");
    expect((fresh.body as { reason: string }).reason).toBe("reply_only");

    const raw = rawMessage({
      from: "Ada <ada@example.com>",
      to: "reply@agents.theserverless.dev",
      subject: "Question",
      messageId: "<ext-reply@example.com>",
      text: "Can you help?",
    });
    await deliver(new FakeMail("ada@example.com", "reply@agents.theserverless.dev", raw));
    const threads = await call(`/v1/inboxes/${inbox.id}/threads`, { headers: bearer(key) });
    const threadId = (threads.body as { threads: { id: string; startedBy: string }[] }).threads.find((row) => row.startedBy === "external")!.id;
    const reply = await call(`/v1/inboxes/${inbox.id}/threads/${threadId}/reply`, {
      method: "POST",
      headers: bearer(key),
      body: JSON.stringify({ text: "Yes" }),
    });
    expect(reply.status).toBe(201);
    expect((reply.body as { outcome: string }).outcome).toBe("sent");
    const messageId = (reply.body as { messageId: string }).messageId;
    const stored = await call(`/v1/inboxes/${inbox.id}/messages/${messageId}`, { headers: bearer(key) });
    expect((stored.body as { inReplyTo: string }).inReplyTo).toBe("<ext-reply@example.com>");
    expect((stored.body as { references: string }).references).toContain("<ext-reply@example.com>");
  });

  it("drafts a reply in a thread the agent started", async () => {
    const token = await asAdmin();
    const agentId = await createAgent(token, { name: "started", policy: "auto", dailySendCap: 10 });
    const key = await mintKey(token, agentId);
    const inbox = await createInbox(token, agentId, "started");
    const first = await sendMail(key, inbox.id, { to: ["ada@example.com"], subject: "Ping", text: "First" });
    expect((first.body as { outcome: string }).outcome).toBe("sent");
    const threadId = (first.body as { threadId: string }).threadId;
    await setAgent(token, agentId, { policy: "reply_only_auto" });
    const follow = await call(`/v1/inboxes/${inbox.id}/threads/${threadId}/reply`, {
      method: "POST",
      headers: bearer(key),
      body: JSON.stringify({ text: "Again" }),
    });
    expect(follow.status).toBe(202);
    expect((follow.body as { reason: string }).reason).toBe("reply_only");
  });

  it("drafts after the daily cap and blocks approval while the kill switch is on", async () => {
    const token = await asAdmin();
    const agentId = await createAgent(token, { name: "capped", policy: "auto", dailySendCap: 1 });
    const key = await mintKey(token, agentId);
    const inbox = await createInbox(token, agentId, "capped");
    const first = await sendMail(key, inbox.id, { to: ["ada@example.com"], subject: "One", text: "A" });
    expect((first.body as { outcome: string }).outcome).toBe("sent");
    const second = await sendMail(key, inbox.id, { to: ["ada@example.com"], subject: "Two", text: "B" });
    expect(second.status).toBe(202);
    const draftId = (second.body as { draftId: string; reason: string }).draftId;
    expect((second.body as { reason: string }).reason).toBe("cap_agent");

    await setAgent(token, agentId, { kill: true });
    const blocked = await call(`/admin/drafts/${draftId}/approve`, { method: "POST", headers: panel(token), body: "{}" });
    expect(blocked.status).toBe(409);
    expect((blocked.body as { error: { code: string } }).error.code).toBe("kill_agent");
    const still = await call(`/v1/drafts/${draftId}`, { headers: bearer(key) });
    expect((still.body as { status: string }).status).toBe("pending");
  });

  it("rejects a block-list recipient", async () => {
    const token = await asAdmin();
    const agentId = await createAgent(token, { name: "lists", policy: "auto", dailySendCap: 10 });
    const key = await mintKey(token, agentId);
    const inbox = await createInbox(token, agentId, "lists");
    const saved = await call(`/admin/inboxes/${inbox.id}`, {
      method: "POST",
      headers: panel(token),
      body: JSON.stringify({ listMode: "block", blocklist: "ada@example.com", status: "active" }),
    });
    expect(saved.status).toBe(200);
    const blocked = await sendMail(key, inbox.id, { to: ["ada@example.com"], subject: "No", text: "Stop" });
    expect(blocked.status).toBe(403);
    expect((blocked.body as { error: { code: string } }).error.code).toBe("blocklist");
  });

  it("matches the decision order in the pure function", () => {
    const base = {
      policy: "auto" as const,
      globalKill: false,
      agentKill: false,
      agentCap: 10,
      agentSent: 0,
      inboxCap: null,
      inboxSent: 0,
      listMode: "none" as const,
      allowlist: [],
      blocklist: ["ada@example.com"],
      recipients: ["ada@example.com"],
      isReply: true,
      threadStartedByExternal: true,
    };
    expect(decide(base).outcome).toBe("blocked");
    const killed = decide({ ...base, blocklist: [], agentKill: true });
    const capped = decide({ ...base, blocklist: [], agentSent: 10 });
    expect(killed.outcome === "draft" && killed.reason).toBe("kill_agent");
    expect(capped.outcome === "draft" && capped.reason).toBe("cap_agent");
  });
});

function panel(token: string): Headers {
  return new Headers({
    "cf-access-jwt-assertion": token,
    accept: "application/json",
    "content-type": "application/json",
  });
}
