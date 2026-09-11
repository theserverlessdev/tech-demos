import PostalMime, { type Address } from "postal-mime";
import type { AttachmentMeta, DeliveryVia, MessageFull } from "../shared/types";
import { newId } from "./auth";
import { countMessages, insertMessage, type InboxRow } from "./db";
import { extractCodes, extractLinks, htmlToText, snippetOf } from "./extract";
import { MAX_HTML_CHARS, MAX_MESSAGES_PER_INBOX, MAX_RAW_BYTES, MAX_TEXT_CHARS } from "./limits";

export type IngestInput = {
  /** PostalMime reads a stream directly, so email() never buffers a message that fails a check. */
  raw: ReadableStream<Uint8Array> | ArrayBuffer | string;
  rawSize: number;
  envelopeFrom: string;
  via: DeliveryVia;
};

/** A reason the message was refused. email() turns it into an SMTP reject, and the API into a 4xx. */
export class Refusal extends Error {
  constructor(
    readonly code: "too_large" | "inbox_full",
    message: string,
  ) {
    super(message);
  }
}

function firstMailbox(address: Address | undefined): { name: string | null; address: string | null } {
  if (!address) return { name: null, address: null };
  const box = address.group ? address.group[0] : address;
  if (!box) return { name: address.name || null, address: null };
  return { name: box.name || null, address: box.address || null };
}

function formatAddresses(list: Address[] | undefined): string | null {
  if (!list?.length) return null;
  return list
    .flatMap((a) => (a.group ? a.group : [a]))
    .map((box) => (box.name ? `${box.name} <${box.address}>` : box.address))
    .join(", ");
}

function cap(value: string | undefined, max: number): { value: string | null; cut: boolean } {
  if (value === undefined || value === "") return { value: null, cut: false };
  return value.length > max ? { value: value.slice(0, max), cut: true } : { value, cut: false };
}

/**
 * The single path from raw MIME to a stored message. The email() handler, the sample button, and the
 * agent test delivery all call it, so a test delivery exercises the same parser and limits as SMTP.
 */
export async function ingest(db: D1Database, inbox: InboxRow, input: IngestInput): Promise<MessageFull> {
  if (input.rawSize > MAX_RAW_BYTES) throw new Refusal("too_large", "The message is larger than 1 MB.");
  if ((await countMessages(db, inbox.id)) >= MAX_MESSAGES_PER_INBOX) {
    throw new Refusal("inbox_full", `The inbox already holds ${MAX_MESSAGES_PER_INBOX} messages.`);
  }

  const parsed = await PostalMime.parse(input.raw, { attachmentEncoding: "arraybuffer" });
  const text = cap(parsed.text, MAX_TEXT_CHARS);
  const html = cap(parsed.html, MAX_HTML_CHARS);
  const readable = text.value ?? (html.value ? htmlToText(html.value) : "");
  const subject = (parsed.subject ?? "").trim() || "(no subject)";
  const from = firstMailbox(parsed.from);

  const attachments: AttachmentMeta[] = parsed.attachments.map((a) => ({
    filename: a.filename,
    mimeType: a.mimeType,
    disposition: a.disposition,
    size: typeof a.content === "string" ? a.content.length : a.content.byteLength,
  }));

  return insertMessage(db, {
    id: newId(),
    inbox_id: inbox.id,
    via: input.via,
    received_at: Date.now(),
    envelope_from: input.envelopeFrom,
    from_name: from.name,
    from_address: from.address,
    to_header: formatAddresses(parsed.to),
    subject: subject.slice(0, 998),
    snippet: snippetOf(readable),
    text_body: text.value,
    html_body: html.value,
    truncated: text.cut || html.cut,
    raw_size: input.rawSize,
    message_id: parsed.messageId ?? null,
    date_header: parsed.date ?? null,
    codes: JSON.stringify(extractCodes(subject, readable)),
    links: JSON.stringify(extractLinks(text.value ?? "", html.value ?? "")),
    attachments: JSON.stringify(attachments),
  });
}

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/**
 * A realistic sign-up message as raw MIME: multipart/alternative inside multipart/mixed, with a small
 * text attachment. The server writes it, so a visitor cannot inject content through this path.
 */
export function sampleMime(to: string, origin: string, domain: string): string {
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  const ticket = newId(4);
  const link = `${origin}/?verified=${ticket}`;
  const outer = `mixed-${newId(6)}`;
  const inner = `alt-${newId(6)}`;
  const date = new Date().toUTCString().replace("GMT", "+0000");

  const text = [
    "Welcome to Ember Cloud.",
    "",
    `Your verification code is ${code}`,
    "",
    `Or confirm your address here: ${link}`,
    "",
    "This code expires in 10 minutes. If you did not sign up, ignore this message.",
  ].join("\r\n");

  const html = `<!doctype html><html><body style="margin:0;background:#f3f1eb;font-family:Helvetica,Arial,sans-serif;color:#17171a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 8px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e4e1d9;border-radius:12px">
<tr><td style="padding:28px 32px 8px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#b23a0a;font-weight:700">Ember Cloud</td></tr>
<tr><td style="padding:0 32px;font-size:22px;font-weight:700">Confirm your email address</td></tr>
<tr><td style="padding:12px 32px;font-size:15px;line-height:1.5;color:#3d3a34">Enter this code to finish your sign-up for <b>${escapeHtml(to)}</b>.</td></tr>
<tr><td style="padding:8px 32px 16px"><div style="font-family:Menlo,monospace;font-size:32px;letter-spacing:.3em;background:#faf9f6;border:1px dashed #c2410c;border-radius:8px;padding:14px 0;text-align:center">${code}</div></td></tr>
<tr><td style="padding:0 32px 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#c2410c;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:8px">Confirm address</a></td></tr>
<tr><td style="padding:16px 32px 28px;border-top:1px solid #ebe8e0;font-size:12px;color:#6b675e">The code expires in 10 minutes. This is a sample message from the temp-email demo.</td></tr>
</table></td></tr></table></body></html>`;

  const receipt = `ticket=${ticket}\r\nissued=${new Date().toISOString()}\r\n`;

  return [
    `From: "Ember Cloud" <sample@${domain}>`,
    `To: <${to}>`,
    `Subject: Your Ember Cloud code is ${code}`,
    `Date: ${date}`,
    `Message-ID: <${newId(8)}@${domain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${outer}"`,
    "",
    `--${outer}`,
    `Content-Type: multipart/alternative; boundary="${inner}"`,
    "",
    `--${inner}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    `--${inner}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    `--${inner}--`,
    `--${outer}`,
    'Content-Type: text/plain; charset=utf-8; name="signup-ticket.txt"',
    'Content-Disposition: attachment; filename="signup-ticket.txt"',
    "Content-Transfer-Encoding: base64",
    "",
    btoa(receipt),
    `--${outer}--`,
    "",
  ].join("\r\n");
}
