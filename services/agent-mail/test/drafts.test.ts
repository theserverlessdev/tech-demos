import { describe, expect, it } from "vitest";
import { asAdmin, bearer, call, createAgent, createInbox, deliver, FakeMail, mintKey, panel, rawMessage, sendMail } from "./helpers";

describe("draft approval", () => {
  it("approves a reply, keeps threading headers, and reports sent", async () => {
    const token = await asAdmin();
    const agentId = await createAgent(token, { name: "queue", policy: "draft", dailySendCap: 10 });
    const key = await mintKey(token, agentId);
    const inbox = await createInbox(token, agentId, "queue");
    await deliver(
      new FakeMail(
        "ada@example.com",
        "queue@agents.theserverless.dev",
        rawMessage({
          from: "Ada <ada@example.com>",
          to: "queue@agents.theserverless.dev",
          subject: "Review",
          messageId: "<review@example.com>",
          text: "Please reply",
        }),
      ),
    );
    const threads = await call(`/v1/inboxes/${inbox.id}/threads`, { headers: bearer(key) });
    const threadId = (threads.body as { threads: { id: string }[] }).threads[0]!.id;
    const held = await call(`/v1/inboxes/${inbox.id}/threads/${threadId}/reply`, {
      method: "POST",
      headers: bearer(key),
      body: JSON.stringify({ text: "Approved text" }),
    });
    expect(held.status).toBe(202);
    const draftId = (held.body as { draftId: string }).draftId;
    const pending = await call(`/v1/drafts/${draftId}`, { headers: bearer(key) });
    expect((pending.body as { status: string }).status).toBe("pending");

    const approved = await call(`/admin/drafts/${draftId}/approve`, { method: "POST", headers: panel(token), body: "{}" });
    expect(approved.status).toBe(200);
    expect((approved.body as { outcome: string }).outcome).toBe("sent");
    const messageId = (approved.body as { messageId: string }).messageId;
    const stored = await call(`/v1/inboxes/${inbox.id}/messages/${messageId}`, { headers: bearer(key) });
    expect((stored.body as { inReplyTo: string; text: string }).inReplyTo).toBe("<review@example.com>");
    expect((stored.body as { text: string }).text).toContain("Approved text");
    const done = await call(`/v1/drafts/${draftId}`, { headers: bearer(key) });
    expect((done.body as { status: string }).status).toBe("sent");
  });

  it("shows an edit diff and can reject a draft", async () => {
    const token = await asAdmin();
    const agentId = await createAgent(token, { name: "edit", policy: "draft", dailySendCap: 10 });
    const key = await mintKey(token, agentId);
    const inbox = await createInbox(token, agentId, "edits");
    const held = await sendMail(key, inbox.id, { to: ["ada@example.com"], subject: "Draft", text: "line one\nline two" });
    const draftId = (held.body as { draftId: string }).draftId;
    const edited = await call(`/admin/drafts/${draftId}/edit`, {
      method: "POST",
      headers: panel(token),
      body: JSON.stringify({ to: "ada@example.com", cc: "", subject: "Draft", text: "line one\nline changed", html: "" }),
    });
    expect(edited.status).toBe(200);
    const page = await call(`/admin/drafts/${draftId}`, { headers: panel(token, false) });
    expect(page.status).toBe(200);
    expect(page.text).toContain("line changed");
    expect(page.text).toContain('class="add"');
    expect(page.text).toContain('class="del"');

    const rejected = await call(`/admin/drafts/${draftId}/reject`, {
      method: "POST",
      headers: panel(token),
      body: JSON.stringify({ note: "No" }),
    });
    expect(rejected.status).toBe(200);
    const status = await call(`/v1/drafts/${draftId}`, { headers: bearer(key) });
    expect((status.body as { status: string }).status).toBe("rejected");
  });
});
