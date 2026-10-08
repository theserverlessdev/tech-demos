import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { insertMessage, insertQuarantine, insertThread } from "../src/db";
import { newId } from "../src/util";
import { signBody } from "../src/webhook";
import { asAdmin, createAgent, createInbox, daysAgo, runCleanup } from "./helpers";

describe("cleanup and webhook signature", () => {
  it("deletes old spam only", async () => {
    const token = await asAdmin();
    const agentId = await createAgent(token, { name: "tidy", policy: "draft", dailySendCap: 5 });
    const inbox = await createInbox(token, agentId, "tidy");
    const old = daysAgo(40);
    const spamThread = await insertThread(env.DB, { id: newId(), inbox_id: inbox.id, subject: "Spam", started_by: "external", now: old });
    const keepThread = await insertThread(env.DB, { id: newId(), inbox_id: inbox.id, subject: "Keep", started_by: "external", now: old });
    const spam = await insertMessage(env.DB, message(spamThread.id, inbox.id, old, 1, "spam-body"));
    const keep = await insertMessage(env.DB, message(keepThread.id, inbox.id, old, 0, "real-body"));
    await env.MAIL_BUCKET.put(spam.raw_r2_key!, "spam-raw");
    await env.MAIL_BUCKET.put("keep-raw", "keep-raw");
    await insertQuarantine(env.DB, {
      id: newId(),
      local_part: "gone",
      envelope_from: "a@example.com",
      subject: "Old spam",
      raw_r2_key: "quarantine/spam.eml",
      spam: 1,
      received_at: old,
    });
    await insertQuarantine(env.DB, {
      id: newId(),
      local_part: "stay",
      envelope_from: "b@example.com",
      subject: "Old real",
      raw_r2_key: "quarantine/real.eml",
      spam: 0,
      received_at: old,
    });
    await env.MAIL_BUCKET.put("quarantine/spam.eml", "q");
    await env.MAIL_BUCKET.put("quarantine/real.eml", "q");

    await runCleanup();

    const spamRow = await env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(spam.id).first();
    const keepRow = await env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(keep.id).first();
    expect(spamRow).toBeNull();
    expect(keepRow).not.toBeNull();
    expect(await readBucket(spam.raw_r2_key!)).toBeNull();
    expect(await readBucket("keep-raw")).toBe("keep-raw");
    const quarantine = await env.DB.prepare("SELECT local_part FROM quarantine ORDER BY local_part").all<{ local_part: string }>();
    expect(quarantine.results.map((row) => row.local_part)).toEqual(["stay"]);
    expect(await readBucket("quarantine/spam.eml")).toBeNull();
    expect(await readBucket("quarantine/real.eml")).toBe("q");
  });

  it("signs the webhook body with HMAC-SHA256", async () => {
    const signature = await signBody("secret", '{"type":"mail.received"}');
    expect(signature.startsWith("sha256=")).toBe(true);
    expect(signature).toHaveLength("sha256=".length + 64);
    const again = await signBody("secret", '{"type":"mail.received"}');
    expect(again).toBe(signature);
    const other = await signBody("other", '{"type":"mail.received"}');
    expect(other).not.toBe(signature);
  });
});

async function readBucket(key: string): Promise<string | null> {
  const object = await env.MAIL_BUCKET.get(key);
  if (!object) return null;
  return object.text();
}

function message(threadId: string, inboxId: string, receivedAt: number, spam: number, text: string) {
  const id = newId();
  return {
    id,
    thread_id: threadId,
    inbox_id: inboxId,
    direction: "inbound" as const,
    via: "smtp" as const,
    received_at: receivedAt,
    envelope_from: "a@example.com",
    from_name: null,
    from_address: "a@example.com",
    to_addrs: "[]",
    cc_addrs: "[]",
    subject: text,
    snippet: text,
    text_body: text,
    html_body: null,
    truncated: 0,
    raw_size: 4,
    raw_r2_key: `raw/${inboxId}/${id}.eml`,
    message_id: `<${id}@example.com>`,
    in_reply_to: null,
    references_header: null,
    date_header: null,
    spam,
    attachments: "[]",
    provider_message_id: null,
  };
}
