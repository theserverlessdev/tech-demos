import { MAX_CODES, MAX_LINKS, SNIPPET_CHARS } from "./limits";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** A rough HTML-to-text pass. It is for snippets and code search only, never for display. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#?\w+);/g, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
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

/** Finds likely one-time codes. Agents use this to pass a sign-up check without a regex of their own. */
export function extractCodes(subject: string, text: string): string[] {
  const found = new Set<string>();
  for (const source of [subject, text]) {
    for (const m of source.matchAll(CODE_NEAR_KEYWORD)) found.add(m[1]);
    for (const m of source.matchAll(CODE_ALONE_ON_LINE)) {
      if (/\d/.test(m[1])) found.add(m[1]);
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
      // Not a URL. Skip it.
    }
  };
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/g)) add(m[0]);
  return [...found].slice(0, MAX_LINKS);
}
