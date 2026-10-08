import type { ResearchCitation, ResearchReply } from "../shared/types";
import { complete } from "./ai";

export const ALLOWED_HOSTS = [
  "developers.cloudflare.com",
  "blog.cloudflare.com",
  "www.cloudflare.com",
  "developer.mozilla.org",
  "en.wikipedia.org",
  "github.com",
  "raw.githubusercontent.com",
  "www.rfc-editor.org",
] as const;

const ALLOWED = new Set<string>(ALLOWED_HOSTS);

const CATALOG: { url: string; terms: string[] }[] = [
  { url: "https://developers.cloudflare.com/workers/static-assets/", terms: ["static", "assets", "html", "hosting"] },
  { url: "https://developers.cloudflare.com/workers/", terms: ["workers", "worker", "serverless"] },
  { url: "https://developers.cloudflare.com/durable-objects/", terms: ["durable", "objects", "sqlite", "alarm"] },
  { url: "https://developers.cloudflare.com/r2/", terms: ["r2", "bucket", "storage"] },
  { url: "https://developers.cloudflare.com/workers-ai/", terms: ["model", "embeddings", "inference"] },
  { url: "https://developers.cloudflare.com/agents/", terms: ["agents", "agent", "assistant"] },
  { url: "https://developers.cloudflare.com/vectorize/", terms: ["vectorize", "vector", "embedding"] },
  { url: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API", terms: ["fetch", "http", "request"] },
];

const MAX_BYTES = 180_000;
const MAX_TEXT = 4_000;
const TIMEOUT_MS = 8_000;
const MAX_HOPS = 2;

export type ResearchFailure = { ok: false; code: string; message: string };
export type ResearchSuccess = { ok: true; summary: string; source: ResearchReply["source"]; citations: ResearchCitation[] };

/** True for loopback, link-local, private, CGNAT, and multicast IPv4 literals. */
function isPrivateV4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

/**
 * Host allowlist is the SSRF boundary. Private IP literals are rejected here so a
 * mistaken allowlist entry cannot reach them. Public IP literals still fail the
 * allowlist, because only hostnames are listed.
 */
function blockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "metadata.google.internal") return true;
  if (host.includes(":")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isPrivateV4(host);
  return false;
}

export function validatePublicUrl(raw: string): { ok: true; url: URL } | ResearchFailure {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: "bad_url", message: "One of the research URLs is not a valid URL." };
  }
  if (url.protocol !== "https:") return { ok: false, code: "bad_url", message: "Research only fetches https URLs." };
  if (url.username || url.password) return { ok: false, code: "bad_url", message: "Research URLs cannot include credentials." };
  if (url.port && url.port !== "443") return { ok: false, code: "bad_url", message: "Research only uses the default https port." };
  if (blockedHost(url.hostname) || !ALLOWED.has(url.hostname)) {
    return { ok: false, code: "host_not_allowed", message: `Host ${url.hostname || "(empty)"} is not on the research allowlist.` };
  }
  url.hash = "";
  return { ok: true, url };
}

export function pickCatalog(question: string): string[] {
  const hay = question.toLowerCase();
  const ranked = CATALOG.map((item) => ({
    url: item.url,
    score: item.terms.filter((term) => hay.includes(term)).length,
  })).sort((a, b) => b.score - a.score);
  const picked = ranked.filter((row) => row.score > 0).slice(0, 3);
  if (picked.length >= 2) return picked.map((row) => row.url);
  return [CATALOG[0]!.url, CATALOG[1]!.url];
}

function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (titleMatch?.[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
  return { title, text: text.slice(0, MAX_TEXT) };
}

async function readCapped(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BYTES) return null;
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf);
}

type Page = { url: string; title: string; text: string };

async function fetchOne(raw: string, hops = 0): Promise<Page | { url: string; error: string }> {
  const checked = validatePublicUrl(raw);
  if (!checked.ok) return { url: raw.slice(0, 300), error: checked.message };
  const target = checked.url.toString();
  let res: Response;
  try {
    res = await fetch(checked.url, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "text/html,text/plain,text/markdown,application/json;q=0.5",
        "user-agent": "tech-demos-personal-agent/1.0",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { url: target, error: "The fetch timed out or failed." };
  }
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (!location || hops >= MAX_HOPS) return { url: target, error: "Too many redirects." };
    return fetchOne(new URL(location, checked.url).toString(), hops + 1);
  }
  if (res.status !== 200) return { url: target, error: `HTTP ${res.status}.` };
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (!/text\/html|text\/plain|text\/markdown|application\/json|application\/xhtml/.test(type)) {
    return { url: target, error: "Unsupported content type." };
  }
  const body = await readCapped(res);
  if (body === null) return { url: target, error: "The page is larger than the size cap." };
  const extracted = /html/.test(type)
    ? htmlToText(body)
    : { title: checked.url.hostname, text: body.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) };
  if (extracted.text.length < 40) return { url: target, error: "The page had too little text." };
  return { url: target, title: extracted.title || checked.url.hostname, text: extracted.text };
}

function fallbackSummary(question: string, pages: Page[]): string {
  const excerpts = pages.map((page) => `${page.title} (${page.url}): ${page.text.slice(0, 280)}`).join("\n\n");
  return `The model is unavailable, so this is an excerpt pack for “${question.slice(0, 160)}”.\n\n${excerpts}`;
}

export async function researchQuestion(env: Env, question: string, urls: string[]): Promise<ResearchSuccess | ResearchFailure> {
  const targets = urls.length ? urls : pickCatalog(question);
  if (targets.length < 2 || targets.length > 4) {
    return { ok: false, code: "bad_urls", message: "Research fetches 2 to 4 pages." };
  }
  for (const url of targets) {
    const checked = validatePublicUrl(url);
    if (!checked.ok) return checked;
  }
  const results = await Promise.all(targets.map((url) => fetchOne(url)));
  const citations: ResearchCitation[] = results.map((result) =>
    "text" in result
      ? { url: result.url, title: result.title, ok: true }
      : { url: result.url, title: result.url, ok: false, error: result.error },
  );
  const pages = results.filter((result): result is Page => "text" in result);
  if (!pages.length) return { ok: false, code: "fetch_failed", message: "None of the pages could be fetched." };
  const packed = pages.map((page) => `URL: ${page.url}\nTitle: ${page.title}\nText: ${page.text}`).join("\n\n---\n\n");
  const summary = await complete(
    env,
    "You summarize public documentation for one visitor. Use only the supplied pages. Cite the source URL in parentheses after each claim. If the pages do not answer the question, say that. Under 160 words. Do not invent pages.",
    `Question: ${question}\n\nPages:\n${packed}`,
  );
  if (!summary) return { ok: true, summary: fallbackSummary(question, pages), source: "fallback", citations };
  return { ok: true, summary, source: "workers-ai", citations };
}
