import { HTML_TO_TEXT_MAX, MAX_CODES, MAX_LINKS, SNIPPET_CHARS } from "./limits";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

const BLOCK_TAGS = ["script", "style", "head", "title"] as const;

function isTagBoundary(code: number): boolean {
  // >, /, whitespace
  return code === 62 || code === 47 || code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

/** Drop `<tag>…</tag>` blocks with indexOf. Unclosed tags drop the remainder. Linear in input length. */
export function stripBlockTags(html: string, tags: readonly string[] = BLOCK_TAGS): string {
  let input = html;
  for (const tag of tags) {
    const open = `<${tag}`;
    const close = `</${tag}>`;
    const lower = input.toLowerCase();
    let out = "";
    let i = 0;
    while (i < input.length) {
      const start = lower.indexOf(open, i);
      if (start === -1) {
        out += input.slice(i);
        break;
      }
      const after = start + open.length;
      if (after < lower.length && !isTagBoundary(lower.charCodeAt(after))) {
        out += input.slice(i, after);
        i = after;
        continue;
      }
      out += input.slice(i, start);
      const end = lower.indexOf(close, after);
      if (end === -1) {
        i = input.length;
        break;
      }
      i = end + close.length;
    }
    input = out;
  }
  return input;
}

function tagNameOf(tag: string): { close: boolean; name: string } {
  const inner = tag.slice(1, -1).trim();
  const close = inner.startsWith("/");
  const body = close ? inner.slice(1).trim() : inner;
  let name = "";
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 47) break;
    name += body.charAt(i).toLowerCase();
  }
  return { close, name };
}

function isBreakName(name: string): boolean {
  return name === "p" || name === "div" || name === "tr" || name === "li" || (name.length === 2 && name.charCodeAt(0) === 104 && name.charCodeAt(1) >= 49 && name.charCodeAt(1) <= 54);
}

/**
 * Replace HTML tags. A tag is `<` then bytes other than `<` or `>` then `>`.
 * A lone `<` is kept as text, so a string of `<` is O(n).
 */
export function replaceTags(html: string): string {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const start = html.indexOf("<", i);
    if (start === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, start);
    const gt = html.indexOf(">", start + 1);
    const nextLt = html.indexOf("<", start + 1);
    if (gt === -1 || (nextLt !== -1 && nextLt < gt)) {
      out += "<";
      i = start + 1;
      continue;
    }
    const tag = html.slice(start, gt + 1);
    const { close, name } = tagNameOf(tag);
    if (name === "br" || (close && isBreakName(name))) out += "\n";
    else out += " ";
    i = gt + 1;
  }
  return out;
}

function decodeEntities(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const amp = text.indexOf("&", i);
    if (amp === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, amp);
    const semi = text.indexOf(";", amp + 1);
    if (semi === -1 || semi - amp > 10) {
      out += "&";
      i = amp + 1;
      continue;
    }
    const name = text.slice(amp + 1, semi);
    out += ENTITIES[name.toLowerCase()] ?? `&${name};`;
    i = semi + 1;
  }
  return out;
}

function collapseWhitespace(text: string): string {
  let out = "";
  let i = 0;
  let blankLines = 0;
  let lineSpace = false;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      if (blankLines < 1) {
        out += "\n";
        blankLines++;
      }
      lineSpace = false;
      i++;
      continue;
    }
    if (c === 32 || c === 9 || c === 12 || c === 13 || c === 11) {
      if (!lineSpace && out.length > 0 && out.charCodeAt(out.length - 1) !== 10) {
        out += " ";
        lineSpace = true;
      }
      i++;
      continue;
    }
    blankLines = 0;
    lineSpace = false;
    out += text.charAt(i);
    i++;
  }
  return out.trim();
}

/** A rough HTML-to-text pass. It is for snippets and code search only, never for display. Linear-time. */
export function htmlToText(html: string): string {
  const input = html.length > HTML_TO_TEXT_MAX ? html.slice(0, HTML_TO_TEXT_MAX) : html;
  return collapseWhitespace(decodeEntities(replaceTags(stripBlockTags(input))));
}

export function snippetOf(text: string): string {
  const flat = collapseWhitespace(text.replace(/\n/g, " "));
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 1)}…` : flat;
}

const CODE_NEAR_KEYWORD = /(?:code|otp|pin|passcode|one[- ]time|verification|verify|confirm|security|login|sign[- ]in)[^\n]{0,40}?\b(\d{4,8})\b/gi;
const CODE_ALONE_ON_LINE = /^[ \t>*]*(\d{4,8}|[A-Z0-9]{3,4}-[A-Z0-9]{3,4})[ \t.*]*$/gm;

/** Finds likely one-time codes. Agents use this to pass a sign-up check without a regex of their own. */
export function extractCodes(subject: string, text: string): string[] {
  const found = new Set<string>();
  for (const source of [subject, text]) {
    // Drop URLs so a port like :8797 next to "confirm" is not treated as a code.
    const plain = source.replace(/https?:\/\/\S+/gi, " ");
    for (const m of plain.matchAll(CODE_NEAR_KEYWORD)) found.add(m[1]);
    for (const m of plain.matchAll(CODE_ALONE_ON_LINE)) {
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
  // Bounded: each match is a quoted href value, not an open-ended scan of `<`.
  for (const m of html.matchAll(/href\s*=\s*"([^"]{1,2048})"|href\s*=\s*'([^']{1,2048})'/gi)) add(m[1] || m[2]);
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']{1,2048}/g)) add(m[0]);
  return [...found].slice(0, MAX_LINKS);
}
