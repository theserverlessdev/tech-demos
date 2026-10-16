import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/util";
import { ORIGIN, asAdmin, bearer, call, createAgent, createInbox, mintKey, panel, sendMail } from "./helpers";

function tokenOf(approveUrl: string): string {
  return new URL(approveUrl).pathname.slice("/a/".length);
}

function postLink(token: string, action: "approve" | "reject", origin: string | null = ORIGIN) {
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  if (origin) headers.set("origin", origin);
  return call(`/a/${token}`, {
    method: "POST",
    headers,
    redirect: "manual",
    body: new URLSearchParams({ token, action }).toString(),
  });
}

async function draftPair(local: string, cap = 10): Promise<{ key: string; token: string; draftId: string; adminToken: string }> {
  const adminToken = await asAdmin();
  const agentId = await createAgent(adminToken, { name: "Link", policy: "draft", dailySendCap: cap });
  const key = await mintKey(adminToken, agentId);
  const inbox = await createInbox(adminToken, agentId, local);
  const held = await sendMail(key, inbox.id, { to: ["ada@example.com"], subject: "Need a look", text: "hello <script>alert(1)</script>" });
  expect(held.status).toBe(202);
  const body = held.body as { draftId: string; approveUrl: string; adminUrl: string };
  expect(body.approveUrl).toBe(`${ORIGIN}/a/${tokenOf(body.approveUrl)}`);
  expect(body.adminUrl).toBe(`${ORIGIN}/admin/drafts/${body.draftId}`);
  return { key, token: tokenOf(body.approveUrl), draftId: body.draftId, adminToken };
}

describe.sequential("approve links", () => {
  it("returns the raw token once and a GET does not change the draft", async () => {
    const { key, token, draftId } = await draftPair("linkbox");
    const row = await env.DB.prepare("SELECT token_hash, used_at FROM approve_tokens WHERE draft_id = ?").bind(draftId).first<{
      token_hash: string;
      used_at: number | null;
    }>();
    expect(row?.token_hash).toBe(await sha256Hex(token));
    expect(row?.token_hash).not.toContain(token);

    const pending = await call(`/v1/drafts/${draftId}`, { headers: bearer(key) });
    const pendingBody = pending.body as { adminUrl?: string; approveUrl?: string; status: string };
    expect(pendingBody.status).toBe("pending");
    expect(pendingBody.adminUrl).toBe(`${ORIGIN}/admin/drafts/${draftId}`);
    expect(pendingBody).not.toHaveProperty("approveUrl");

    const response = await SELF.fetch(new Request(`${ORIGIN}/a/${token}`));
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("Need a look");
    expect(html).toContain("Approve &amp; send");
    expect(html).toContain("hello &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
    await SELF.fetch(new Request(`${ORIGIN}/a/${token}`));

    const after = await env.DB.prepare("SELECT used_at FROM approve_tokens WHERE draft_id = ?").bind(draftId).first<{ used_at: number | null }>();
    expect(after?.used_at).toBeNull();
    const status = await call(`/v1/drafts/${draftId}`, { headers: bearer(key) });
    expect((status.body as { status: string }).status).toBe("pending");
  });

  it("approves once through the same send path and rejects a second use", async () => {
    const { key, token, draftId } = await draftPair("linkonce");
    const approved = await postLink(token, "approve");
    expect(approved.status).toBe(303);
    expect(approved.text).toBe("");
    const done = await call("/a/done?result=sent");
    expect(done.text).toContain("Sent.");
    const status = await call(`/v1/drafts/${draftId}`, { headers: bearer(key) });
    expect((status.body as { status: string }).status).toBe("sent");
    const audit = await env.DB.prepare("SELECT actor_type FROM audit_log WHERE action = 'draft.approved' AND target_id = ?")
      .bind(draftId)
      .first<{ actor_type: string }>();
    expect(audit?.actor_type).toBe("approve_link");

    const again = await postLink(token, "approve");
    expect(again.status).toBe(200);
    expect(again.text).toContain("This link is not active");
    const sent = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE from_address = ?").bind("linkonce@agents.theserverless.dev").first<{ n: number }>();
    expect(sent?.n).toBe(1);
  });

  it("rejects from the link and does not send", async () => {
    const { key, token, draftId } = await draftPair("linkno");
    const rejected = await postLink(token, "reject");
    expect(rejected.status).toBe(303);
    const status = await call(`/v1/drafts/${draftId}`, { headers: bearer(key) });
    expect((status.body as { status: string }).status).toBe("rejected");
    const again = await postLink(token, "approve");
    expect(again.text).toContain("This link is not active");
    const sent = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE from_address = ?").bind("linkno@agents.theserverless.dev").first<{ n: number }>();
    expect(sent?.n).toBe(0);
  });

  it("ignores an expired token", async () => {
    const { key, token, draftId } = await draftPair("linkold");
    await env.DB.prepare("UPDATE approve_tokens SET expires_at = ? WHERE draft_id = ?").bind(Date.now() - 1000, draftId).run();
    const view = await call(`/a/${token}`);
    expect(view.text).toContain("This link is not active");
    expect(view.text).not.toContain("Need a look");
    const posted = await postLink(token, "approve");
    expect(posted.text).toContain("This link is not active");
    const status = await call(`/v1/drafts/${draftId}`, { headers: bearer(key) });
    expect((status.body as { status: string }).status).toBe("pending");
  });

  it("invalidates the link when the draft is edited, rejected, or approved in admin", async () => {
    const edited = await draftPair("linkedit");
    const saved = await call(`/admin/drafts/${edited.draftId}/edit`, {
      method: "POST",
      headers: panel(edited.adminToken),
      body: JSON.stringify({ to: "ada@example.com", cc: "", subject: "Need a look", text: "changed", html: "" }),
    });
    expect(saved.status).toBe(200);
    const afterEdit = await call(`/a/${edited.token}`);
    expect(afterEdit.text).toContain("This link is not active");

    const rejected = await draftPair("linkrej");
    const adminReject = await call(`/admin/drafts/${rejected.draftId}/reject`, {
      method: "POST",
      headers: panel(rejected.adminToken),
      body: JSON.stringify({ note: "No" }),
    });
    expect(adminReject.status).toBe(200);
    expect((await call(`/a/${rejected.token}`)).text).toContain("This link is not active");

    const approved = await draftPair("linkadm");
    const adminApprove = await call(`/admin/drafts/${approved.draftId}/approve`, {
      method: "POST",
      headers: panel(approved.adminToken),
      body: "{}",
    });
    expect(adminApprove.status).toBe(200);
    const late = await postLink(approved.token, "approve");
    expect(late.text).toContain("This link is not active");
    const sent = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE from_address = ?").bind("linkadm@agents.theserverless.dev").first<{ n: number }>();
    expect(sent?.n).toBe(1);
  });

  it("still enforces the daily cap", async () => {
    const { key, token, draftId } = await draftPair("linkcap", 0);
    const blocked = await postLink(token, "approve");
    expect(blocked.status).toBe(409);
    expect(blocked.text).toContain("daily send cap");
    const status = await call(`/v1/drafts/${draftId}`, { headers: bearer(key) });
    expect((status.body as { status: string }).status).toBe("pending");
    const view = await call(`/a/${token}`);
    expect(view.text).toContain("Need a look");
    const sent = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE from_address = ?").bind("linkcap@agents.theserverless.dev").first<{ n: number }>();
    expect(sent?.n).toBe(0);
  });

  it("does not approve without a same-origin header, and stops when links are turned off", async () => {
    const { key, token, draftId, adminToken } = await draftPair("linkoff");
    const cross = await postLink(token, "approve", null);
    expect(cross.text).toContain("This link is not active");
    expect(((await call(`/v1/drafts/${draftId}`, { headers: bearer(key) })).body as { status: string }).status).toBe("pending");
    const chrome = await call(`/a/${token}`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: "null", "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, action: "approve" }).toString(),
    });
    expect(chrome.status).toBe(303);
    expect(((await call(`/v1/drafts/${draftId}`, { headers: bearer(key) })).body as { status: string }).status).toBe("sent");

    const saved = await call("/admin/settings", {
      method: "POST",
      headers: panel(adminToken),
      body: JSON.stringify({ unknownPolicy: "reject", spamTtlDays: 30, globalKill: false, approveLinks: false }),
    });
    expect(saved.status).toBe(200);
    const hidden = await call(`/a/${token}`);
    expect(hidden.text).toContain("This link is not active");
    expect(hidden.text).not.toContain("Need a look");
    const inbox = await env.DB.prepare("SELECT id FROM inboxes WHERE local_part = ?").bind("linkoff").first<{ id: string }>();
    const held = await sendMail(key, inbox!.id, {
      to: ["ada@example.com"],
      subject: "Second",
      text: "no link",
    });
    expect((held.body as { approveUrl: string | null }).approveUrl).toBeNull();
    expect((held.body as { adminUrl: string }).adminUrl).toContain("/admin/drafts/");
  });
});
