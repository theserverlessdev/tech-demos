import type { AttachmentMeta } from "./types";

export const MAX_RAW_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_CHARS = 256 * 1024;
export const MAX_HTML_CHARS = 512 * 1024;
export const MAX_WAIT_SECONDS = 25;
export const WAIT_POLL_MS = 1000;
export const SNIPPET_CHARS = 160;
export const MAX_CODES = 5;
export const MAX_LINKS = 20;
export const MAX_RECIPIENTS = 20;
export const DEFAULT_AGENT_CAP = 50;
export const API_KEY_PREFIX = "am1_";
export const MAX_NAME = 80;
export const DAY_MS = 86_400_000;

const textEncoder = new TextEncoder();

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function newId(bytes = 16): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function bytesFromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function newApiKey(): string {
  return `${API_KEY_PREFIX}${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export function keyHint(key: string): string {
  return `${key.slice(0, 12)}…`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", textEncoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, textEncoder.encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function encryptString(master: string, plain: string): Promise<string> {
  const raw = await crypto.subtle.digest("SHA-256", textEncoder.encode(master));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, textEncoder.encode(plain)));
  return `${base64Url(iv)}.${base64Url(ct)}`;
}

export async function decryptString(master: string, stored: string): Promise<string> {
  const [ivPart, ctPart] = stored.split(".");
  if (!ivPart || !ctPart) throw new Error("bad ciphertext");
  const raw = await crypto.subtle.digest("SHA-256", textEncoder.encode(master));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const iv = bytesFromBase64Url(ivPart);
  const ct = bytesFromBase64Url(ctPart);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: asBuffer(iv) }, key, asBuffer(ct));
  return new TextDecoder().decode(plain);
}

function asBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function originOf(env: Env): string {
  return env.PUBLIC_ORIGIN.replace(/\/$/, "");
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function esc(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function srcdocAttr(html: string): string {
  return html.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

export function checkLocalPart(value: string): string | null {
  if (value.length < 1 || value.length > 64) return "Use 1 to 64 characters.";
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(value)) {
    return "Use lowercase letters, digits, dots, underscores, and hyphens.";
  }
  if (value.includes("..")) return "Do not use two dots in a row.";
  return null;
}

export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return null;
  if (email.length > 254) return null;
  return email;
}

export function normalizeRecipients(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const email = normalizeEmail(value);
    if (!email) throw new HttpError(400, "bad_request", `Recipient "${value.slice(0, 80)}" is not a valid email address.`);
    if (!out.includes(email)) out.push(email);
  }
  return out;
}

export function splitList(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

export function listMatches(list: string[], email: string): boolean {
  const domain = email.split("@")[1] ?? "";
  return list.some((entry) => {
    if (entry.startsWith("@")) return domain === entry.slice(1);
    if (!entry.includes("@")) return domain === entry;
    return email === entry;
  });
}

export function capText(value: string | undefined | null, max: number): { value: string | null; cut: boolean } {
  if (value == null || value === "") return { value: null, cut: false };
  return value.length > max ? { value: value.slice(0, max), cut: true } : { value, cut: false };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Rough HTML to text for snippets and code search. Not for display. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#?\w+);/g, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 1)}…` : flat;
}

const CODE_NEAR_KEYWORD = /(?:code|otp|pin|passcode|one[- ]time|verification|verify|confirm|security|login|sign[- ]in)[^\n]{0,40}?\b(\d{4,8})\b/gi;
const CODE_ALONE_ON_LINE = /^[ \t>*]*(\d{4,8}|[A-Z0-9]{3,4}-[A-Z0-9]{3,4})[ \t.*]*$/gm;

export function extractCodes(subject: string, text: string): string[] {
  const found = new Set<string>();
  for (const source of [subject, text]) {
    for (const match of source.matchAll(CODE_NEAR_KEYWORD)) found.add(match[1]);
    for (const match of source.matchAll(CODE_ALONE_ON_LINE)) {
      if (/\d/.test(match[1])) found.add(match[1]);
    }
    if (found.size >= MAX_CODES) break;
  }
  return [...found].slice(0, MAX_CODES);
}

export function extractLinks(text: string, html: string): string[] {
  const found = new Set<string>();
  const add = (raw: string) => {
    const cleaned = raw.replace(/&amp;/g, "&").replace(/[)\].,;:!?'"]+$/, "");
    try {
      const url = new URL(cleaned);
      if (url.protocol === "https:" || url.protocol === "http:") found.add(url.toString());
    } catch {
      // Skip values that are not URLs.
    }
  };
  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) add(match[1]);
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/g)) add(match[0]);
  return [...found].slice(0, MAX_LINKS);
}

export function formatMessageId(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed;
  return `<${trimmed.replace(/^<|>$/g, "")}>`;
}

export function messageIdTokens(value: string | null | undefined): string[] {
  if (!value) return [];
  const found = new Set<string>();
  for (const match of value.matchAll(/<[^<>\s]+>/g)) found.add(match[0]);
  if (found.size === 0) {
    for (const part of value.split(/\s+/)) {
      const formatted = formatMessageId(part);
      if (formatted) found.add(formatted);
    }
  }
  return [...found].slice(0, 32);
}

/** Keep the first id and as many recent ids as fit in the header limit. */
export function buildReferences(ids: string[], limit = 1800): string {
  const formatted = ids.map((id) => formatMessageId(id)).filter(Boolean);
  if (!formatted.length) return "";
  const first = formatted[0];
  const rest = formatted.slice(1);
  const kept: string[] = [];
  let size = first.length;
  for (let i = rest.length - 1; i >= 0; i--) {
    const next = rest[i];
    if (size + 1 + next.length > limit) break;
    kept.push(next);
    size += 1 + next.length;
  }
  kept.reverse();
  const unique = [first, ...kept.filter((id) => id !== first)];
  return unique.join(" ");
}

export function replySubject(subject: string): string {
  const value = subject.trim() || "(no subject)";
  return /^re:/i.test(value) ? value : `Re: ${value}`;
}

export function isSpamHeaders(headers: Headers): boolean {
  const yes = (name: string) => /^yes\b/i.test((headers.get(name) ?? "").trim());
  return yes("x-spam") || yes("x-spam-flag") || yes("x-cf-spam");
}

export function safeFilename(name: string | null | undefined): string {
  const base = (name ?? "attachment").split(/[/\\]/).pop() || "attachment";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 80);
  return cleaned || "attachment";
}

export function contentDisposition(filename: string | null): string {
  const raw = filename || "attachment";
  const ascii = raw.replace(/[^\x20-\x7E]+/g, "_").replace(/["\\]/g, "_") || "attachment";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

export function parseAttachments(value: string): AttachmentMeta[] {
  const list = parseJson<AttachmentMeta[]>(value, []);
  return Array.isArray(list) ? list : [];
}

export type DiffLine = { op: " " | "-" | "+"; text: string };

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 40_000) {
    return [...a.map((text) => ({ op: "-" as const, text })), ...b.map((text) => ({ op: "+" as const, text }))];
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ op: " ", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ op: "-", text: a[i] });
      i++;
    } else {
      lines.push({ op: "+", text: b[j] });
      j++;
    }
  }
  while (i < a.length) lines.push({ op: "-", text: a[i++] });
  while (j < b.length) lines.push({ op: "+", text: b[j++] });
  return lines;
}

export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export async function csrfToken(env: Env, userId: string, now = Date.now()): Promise<string> {
  if (!env.WEBHOOK_KEY) throw new HttpError(500, "misconfigured", "WEBHOOK_KEY is not set.");
  return hmacHex(env.WEBHOOK_KEY, `csrf|${userId}|${utcDay(now)}`);
}
