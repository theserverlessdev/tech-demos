import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { asAdmin, call, createAgent, createInbox, deliver, FakeMail, mintKey, rawMessage, bearer } from "./helpers";

const domain = "agents.theserverless.dev";

describe("inbound", () => {
  it("stores a multipart message, the raw file, and the attachment", async () => {
    const token = await asAdmin();
    const agentId = await createAgent(token, { name: "rescue-bot", policy: "draft", dailySendCap: 10 });
    const key = await mintKey(token, agentId);
    const inbox = await createInbox(token, agentId, "rescue");
    const raw = rawMessage({
      from: "Ada Lovelace <ada@example.com>",
      to: `rescue@${domain}`,
      subject: "Need a hand",
      messageId: "<inbound-1@example.com>",
      text: "Your code is 123456",
      html: "<p>Your code is <b>123456</b></p>",
      attachment: { filename: "note.txt", content: "hello-bytes" },
    });
    const message = new FakeMail("ada@example.com", `rescue@${domain}`, raw);
    await deliver(message);
    expect(message.rejected).toBeNull();

    const threads = await call(`/v1/inboxes/${inbox.id}/threads`, { headers: bearer(key) });
    expect(threads.status).toBe(200);
    const listed = threads.body as { threads: { id: string; startedBy: string; subject: string }[] };
    expect(listed.threads).toHaveLength(1);
    expect(listed.threads[0]?.startedBy).toBe("external");
    expect(listed.threads[0]?.subject).toBe("Need a hand");

    const detail = await call(`/v1/inboxes/${inbox.id}/threads/${listed.threads[0]!.id}`, { headers: bearer(key) });
    const view = detail.body as {
      messages: { id: string; text: string; html: string; messageId: string; spam: boolean; attachments: { filename: string }[]; codes: string[] }[];
    };
    const stored = view.messages[0]!;
    expect(stored.text).toContain("123456");
    expect(stored.html).toContain("<b>123456</b>");
    expect(stored.messageId).toBe("<inbound-1@example.com>");
    expect(stored.spam).toBe(false);
    expect(stored.codes).toContain("123456");
    expect(stored.attachments[0]?.filename).toBe("note.txt");

    const file = await call(`/v1/inboxes/${inbox.id}/messages/${stored.id}/attachments/0`, { headers: bearer(key) });
    expect(file.status).toBe(200);
    expect(file.text.trim()).toBe("hello-bytes");

    const eml = await call(`/v1/inboxes/${inbox.id}/messages/${stored.id}/raw`, { headers: bearer(key) });
    expect(eml.status).toBe(200);
    expect(eml.text).toContain("hello-bytes");
    expect(eml.text).toContain("Need a hand");
  });

  it("strips a plus tag and flags spam", async () => {
    const token = await asAdmin();
    const agentId = await createAgent(token, { name: "audit-bot", policy: "draft", dailySendCap: 10 });
    const key = await mintKey(token, agentId);
    const inbox = await createInbox(token, agentId, "audit");
    const raw = rawMessage({
      from: "spam@example.com",
      to: `audit+tag@${domain}`,
      subject: "Offer",
      messageId: "<spam-1@example.com>",
      text: "Ignore this",
    });
    const message = new FakeMail("spam@example.com", `audit+tag@${domain}`, raw, new Headers({ "x-spam": "Yes" }));
    await deliver(message);
    expect(message.rejected).toBeNull();
    const list = await call(`/v1/inboxes/${inbox.id}/messages`, { headers: bearer(key) });
    const rows = (list.body as { messages: { spam: boolean; subject: string }[] }).messages;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.spam).toBe(true);
    expect(rows[0]?.subject).toBe("Offer");
  });

  it("rejects an unknown address", async () => {
    await asAdmin();
    const message = new FakeMail(
      "ada@example.com",
      `nobody@${domain}`,
      rawMessage({
        from: "ada@example.com",
        to: `nobody@${domain}`,
        subject: "Hi",
        messageId: "<nope@example.com>",
        text: "Hello",
      }),
    );
    await deliver(message);
    expect(message.rejected).toBe("No inbox has this address.");
  });

  it("quarantines an unknown address when that policy is on", async () => {
    const token = await asAdmin();
    const saved = await call("/admin/settings", {
      method: "POST",
      headers: panelJson(token),
      body: JSON.stringify({ unknownPolicy: "quarantine", spamTtlDays: 30, globalKill: false }),
    });
    expect(saved.status).toBe(200);
    const message = new FakeMail(
      "ada@example.com",
      `ghost@${domain}`,
      rawMessage({
        from: "ada@example.com",
        to: `ghost@${domain}`,
        subject: "Held",
        messageId: "<held@example.com>",
        text: "Keep me",
      }),
    );
    await deliver(message);
    expect(message.rejected).toBeNull();
    const row = await env.DB.prepare("SELECT local_part, subject FROM quarantine").first<{ local_part: string; subject: string }>();
    expect(row?.local_part).toBe("ghost");
    expect(row?.subject).toBe("Held");
  });

  it("rejects a disabled inbox", async () => {
    const token = await asAdmin();
    const agentId = await createAgent(token, { name: "off", policy: "draft", dailySendCap: 10 });
    const inbox = await createInbox(token, agentId, "paused");
    const saved = await call(`/admin/inboxes/${inbox.id}`, {
      method: "POST",
      headers: panelJson(token),
      body: JSON.stringify({ status: "disabled", listMode: "none" }),
    });
    expect(saved.status).toBe(200);
    const message = new FakeMail(
      "ada@example.com",
      `paused@${domain}`,
      rawMessage({
        from: "ada@example.com",
        to: `paused@${domain}`,
        subject: "Hi",
        messageId: "<off@example.com>",
        text: "Hello",
      }),
    );
    await deliver(message);
    expect(message.rejected).toBe("This inbox is disabled.");
  });
});

function panelJson(token: string): Headers {
  return new Headers({
    "cf-access-jwt-assertion": token,
    accept: "application/json",
    "content-type": "application/json",
  });
}
