import { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { importJWK, SignJWT, type JWK } from "jose";
import worker from "../src/index";
import type { AgentRow } from "../src/types";
import { DAY_MS } from "../src/util";

export const ORIGIN = "https://agents.theserverless.dev";

export class FakeMail implements ForwardableEmailMessage {
  rejected: string | null = null;
  readonly raw: ReadableStream<Uint8Array>;
  readonly headers: Headers;
  readonly rawSize: number;

  constructor(
    readonly from: string,
    readonly to: string,
    raw: string,
    headers?: Headers,
    rawSize?: number,
  ) {
    const bytes = new TextEncoder().encode(raw);
    const stream = new Response(bytes).body;
    if (!stream) throw new Error("raw body is empty");
    this.raw = stream;
    this.headers = headers ?? new Headers();
    this.rawSize = rawSize ?? bytes.byteLength;
  }

  setReject(reason: string): void {
    this.rejected = reason;
  }

  forward(): Promise<EmailSendResult> {
    return Promise.resolve({ messageId: "forwarded" });
  }

  reply(): Promise<EmailSendResult> {
    return Promise.resolve({ messageId: "replied" });
  }
}

export function rawMessage(input: {
  from: string;
  to: string;
  subject: string;
  messageId: string;
  text: string;
  html?: string;
  attachment?: { filename: string; content: string };
}): string {
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Message-ID: ${input.messageId}`,
    "Date: Thu, 08 Oct 2026 12:00:00 +0000",
    "MIME-Version: 1.0",
  ];
  if (!input.html && !input.attachment) {
    headers.push("Content-Type: text/plain; charset=utf-8");
    return `${headers.join("\r\n")}\r\n\r\n${input.text}\r\n`;
  }
  const boundary = "am-bound";
  headers.push(`Content-Type: multipart/mixed; boundary=${boundary}`);
  let body = "";
  if (input.html) {
    const alt = "am-alt";
    body += `--${boundary}\r\nContent-Type: multipart/alternative; boundary=${alt}\r\n\r\n`;
    body += `--${alt}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${input.text}\r\n`;
    body += `--${alt}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${input.html}\r\n`;
    body += `--${alt}--\r\n`;
  } else {
    body += `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${input.text}\r\n`;
  }
  if (input.attachment) {
    body += `--${boundary}\r\nContent-Type: text/plain; name="${input.attachment.filename}"\r\nContent-Disposition: attachment; filename="${input.attachment.filename}"\r\n\r\n${input.attachment.content}\r\n`;
  }
  body += `--${boundary}--\r\n`;
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

export async function deliver(message: FakeMail): Promise<void> {
  if (!worker.email) throw new Error("email handler is missing");
  const ctx = createExecutionContext();
  await worker.email(message, env, ctx);
  await waitOnExecutionContext(ctx);
}

export async function runCleanup(): Promise<void> {
  if (!worker.scheduled) throw new Error("scheduled handler is missing");
  await worker.scheduled(createScheduledController({ cron: "17 * * * *", scheduledTime: new Date() }), env);
}

type Json = Record<string, unknown> | unknown[] | string | null;

export async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: Json; text: string }> {
  const response = await SELF.fetch(new Request(`${ORIGIN}${path}`, init));
  const text = await response.text();
  let body: Json = null;
  if (text) {
    try {
      body = JSON.parse(text) as Json;
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, text };
}

export async function signAccess(email: string, opts?: { aud?: string; iss?: string; key?: JWK }): Promise<string> {
  const jwk = opts?.key ?? (JSON.parse(env.ACCESS_TEST_PRIVATE_JWK ?? "{}") as JWK);
  const key = await importJWK(jwk, "RS256");
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(opts?.iss ?? env.TEAM_DOMAIN.replace(/\/$/, ""))
    .setAudience(opts?.aud ?? env.POLICY_AUD)
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(key);
}

export function panel(token: string, json = true): Headers {
  const headers = new Headers({ "cf-access-jwt-assertion": token });
  if (json) {
    headers.set("accept", "application/json");
    headers.set("content-type", "application/json");
  }
  return headers;
}

export function bearer(key: string): Headers {
  return new Headers({ authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" });
}

export async function asAdmin(): Promise<string> {
  const token = await signAccess(env.ADMIN_EMAIL);
  const home = await call("/admin/mail", { headers: panel(token, false) });
  if (home.status !== 200) throw new Error(`bootstrap failed ${home.status} ${home.text}`);
  return token;
}

export async function createAgent(token: string, fields: { name: string; policy: string; dailySendCap: number }): Promise<string> {
  const created = await call("/admin/agents", { method: "POST", headers: panel(token), body: JSON.stringify(fields) });
  if (created.status !== 200 || !created.body || typeof created.body !== "object" || Array.isArray(created.body)) {
    throw new Error(`create agent failed ${created.status} ${created.text}`);
  }
  return String(created.body.id);
}

export async function mintKey(token: string, agentId: string): Promise<string> {
  const minted = await call(`/admin/agents/${agentId}/keys`, {
    method: "POST",
    headers: panel(token),
    body: JSON.stringify({ name: "ci" }),
  });
  if (minted.status !== 201 || !minted.body || typeof minted.body !== "object" || Array.isArray(minted.body)) {
    throw new Error(`mint failed ${minted.status} ${minted.text}`);
  }
  return String(minted.body.key);
}

export async function createInbox(
  token: string,
  agentId: string,
  localPart: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; address: string }> {
  const created = await call(`/admin/agents/${agentId}/inboxes`, {
    method: "POST",
    headers: panel(token),
    body: JSON.stringify({ localPart, ...extra }),
  });
  if (created.status !== 200 || !created.body || typeof created.body !== "object" || Array.isArray(created.body)) {
    throw new Error(`inbox failed ${created.status} ${created.text}`);
  }
  return { id: String(created.body.id), address: String(created.body.address) };
}

export async function setAgent(token: string, agentId: string, patch: { policy?: string; dailySendCap?: number; kill?: boolean }): Promise<void> {
  const row = await env.DB.prepare("SELECT * FROM agents WHERE id = ?").bind(agentId).first<AgentRow>();
  if (!row) throw new Error("agent missing");
  const saved = await call(`/admin/agents/${agentId}`, {
    method: "POST",
    headers: panel(token),
    body: JSON.stringify({
      name: row.name,
      policy: patch.policy ?? row.policy,
      dailySendCap: patch.dailySendCap ?? row.daily_send_cap,
      kill: patch.kill ?? row.kill_switch === 1,
      webhookUrl: row.webhook_url,
    }),
  });
  if (saved.status !== 200) throw new Error(`agent update failed ${saved.status} ${saved.text}`);
}

export async function sendMail(key: string, inboxId: string, body: Record<string, unknown>) {
  return call(`/v1/inboxes/${inboxId}/send`, { method: "POST", headers: bearer(key), body: JSON.stringify(body) });
}

export function daysAgo(days: number): number {
  return Date.now() - days * DAY_MS;
}
