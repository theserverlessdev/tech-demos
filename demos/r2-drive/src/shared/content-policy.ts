import { FINDER_MAX_BYTES, MAX_FILE_BYTES } from "./constants";

/**
 * One list. `sniff` walks it from top to bottom and stops at the first match.
 * ZIP-based office files are rejected with the other archives. OLE is not accepted.
 */
export type ContentRule =
  | {
      id: string;
      action: "deny";
      group: "image" | "video" | "audio" | "archive" | "binary" | "encrypted";
      bytes?: number[];
      at?: number;
      and?: { at: number; bytes: number[] };
      textPrefix?: string;
    }
  | { id: "pdf"; action: "allow"; kind: "pdf"; bytes: number[] }
  | { id: "utf8-text"; action: "allow-text"; kind: "text" };

const text = (value: string): number[] => [...value].map((ch) => ch.charCodeAt(0));

export const CONTENT_RULES: ContentRule[] = [
  { id: "png", action: "deny", group: "image", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { id: "jpeg", action: "deny", group: "image", bytes: [0xff, 0xd8, 0xff] },
  { id: "gif87", action: "deny", group: "image", bytes: text("GIF87a") },
  { id: "gif89", action: "deny", group: "image", bytes: text("GIF89a") },
  { id: "webp", action: "deny", group: "image", bytes: text("RIFF"), and: { at: 8, bytes: text("WEBP") } },
  { id: "bmp", action: "deny", group: "image", bytes: text("BM"), and: { at: 6, bytes: [0, 0, 0, 0] } },
  { id: "tiff-le", action: "deny", group: "image", bytes: [0x49, 0x49, 0x2a, 0x00] },
  { id: "tiff-be", action: "deny", group: "image", bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  { id: "ico", action: "deny", group: "image", bytes: [0x00, 0x00, 0x01, 0x00] },
  { id: "isobmff", action: "deny", group: "video", at: 4, bytes: text("ftyp") },
  { id: "webm", action: "deny", group: "video", bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  { id: "avi", action: "deny", group: "video", bytes: text("RIFF"), and: { at: 8, bytes: text("AVI ") } },
  { id: "ogg", action: "deny", group: "audio", bytes: text("OggS") },
  { id: "flac", action: "deny", group: "audio", bytes: text("fLaC") },
  { id: "wav", action: "deny", group: "audio", bytes: text("RIFF"), and: { at: 8, bytes: text("WAVE") } },
  { id: "mp3", action: "deny", group: "audio", bytes: text("ID3") },
  { id: "gzip", action: "deny", group: "archive", bytes: [0x1f, 0x8b] },
  { id: "bz2", action: "deny", group: "archive", bytes: text("BZh") },
  { id: "xz", action: "deny", group: "archive", bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { id: "zstd", action: "deny", group: "archive", bytes: [0x28, 0xb5, 0x2f, 0xfd] },
  { id: "7z", action: "deny", group: "archive", bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { id: "rar", action: "deny", group: "archive", bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] },
  { id: "elf", action: "deny", group: "binary", bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { id: "mz", action: "deny", group: "binary", bytes: text("MZ") },
  { id: "macho-be", action: "deny", group: "binary", bytes: [0xfe, 0xed, 0xfa, 0xce] },
  { id: "macho-le", action: "deny", group: "binary", bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { id: "wasm", action: "deny", group: "binary", bytes: [0x00, 0x61, 0x73, 0x6d] },
  { id: "sqlite", action: "deny", group: "binary", bytes: text("SQLite format 3") },
  { id: "zip", action: "deny", group: "archive", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { id: "zip-empty", action: "deny", group: "archive", bytes: [0x50, 0x4b, 0x05, 0x06] },
  { id: "pdf", action: "allow", kind: "pdf", bytes: text("%PDF-") },
  { id: "ole", action: "deny", group: "binary", bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  { id: "pgp", action: "deny", group: "encrypted", textPrefix: "-----BEGIN PGP" },
  { id: "age", action: "deny", group: "encrypted", textPrefix: "age-encryption.org/" },
  { id: "age-armour", action: "deny", group: "encrypted", textPrefix: "-----BEGIN AGE ENCRYPTED FILE-----" },
  { id: "openssl", action: "deny", group: "encrypted", textPrefix: "Salted__" },
  { id: "utf8-text", action: "allow-text", kind: "text" },
];

const PDF_TOKENS = ["/EmbeddedFile", "/JavaScript", "/JS", "/Launch", "/RichMedia"];
const ARMOUR = ["-----BEGIN PGP", "-----BEGIN AGE ENCRYPTED FILE-----", "age-encryption.org/", "Salted__"];

/** Signatures that must not appear anywhere inside a PDF body. */
const PDF_DENY: number[][] = [
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  [0xff, 0xd8, 0xff],
  text("GIF87a"),
  text("GIF89a"),
  text("WEBP"),
  [0x1a, 0x45, 0xdf, 0xa3],
  text("OggS"),
  text("fLaC"),
  text("ID3"),
  [0x1f, 0x8b],
  text("BZh"),
  [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
  [0x28, 0xb5, 0x2f, 0xfd],
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
  [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07],
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x7f, 0x45, 0x4c, 0x46],
  text("MZ"),
  [0xfe, 0xed, 0xfa, 0xce],
  [0xce, 0xfa, 0xed, 0xfe],
  [0x00, 0x61, 0x73, 0x6d],
  text("SQLite format 3"),
  [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  text("ftyp"),
  text("ustar"),
];

export type Sniff =
  | { ok: true; kind: "text" | "json" | "pdf"; mediaType: string; inline: boolean }
  | { ok: false; reason: string };

export function isFinderNoise(key: string): boolean {
  const base = key.split("/").pop() ?? "";
  return base === ".DS_Store" || base.startsWith("._");
}

const APPLE_DOUBLE = [0x00, 0x05, 0x16, 0x07];
const DS_STORE = [0x00, 0x00, 0x00, 0x01, 0x42, 0x75, 0x64, 0x31];
/** JPEG markers are 4 bytes so a short `MZ` inside other metadata is not a hit. */
const FINDER_JPEG = [
  [0xff, 0xd8, 0xff, 0xe0],
  [0xff, 0xd8, 0xff, 0xe1],
  [0xff, 0xd8, 0xff, 0xdb],
  [0xff, 0xd8, 0xff, 0xee],
];

export function checkFinder(key: string, bytes: Uint8Array): { ok: true } | { ok: false; status: 413 | 415; reason: string } {
  if (bytes.byteLength > FINDER_MAX_BYTES) return { ok: false, status: 413, reason: "Finder metadata is too large" };
  const base = key.split("/").pop() ?? "";
  const magic = base === ".DS_Store" ? DS_STORE : APPLE_DOUBLE;
  if (!matches(bytes, magic, 0)) return { ok: false, status: 415, reason: "Rejected Finder metadata" };
  const blocked = [...PDF_DENY.filter((signature) => signature.length >= 4), ...FINDER_JPEG];
  for (const signature of blocked) {
    if (indexOf(bytes, signature, 0) !== -1) return { ok: false, status: 415, reason: "Rejected Finder metadata" };
  }
  return { ok: true };
}

export async function sniff(bytes: Uint8Array): Promise<Sniff> {
  if (bytes.byteLength > MAX_FILE_BYTES) {
    return { ok: false, reason: "File is over 5 MB" };
  }
  if (bytes.byteLength === 0) {
    return { ok: true, kind: "text", mediaType: "text/plain; charset=utf-8", inline: true };
  }
  if (hasTarMagic(bytes)) return { ok: false, reason: "Rejected archive: tar" };

  for (const rule of CONTENT_RULES) {
    if (rule.action === "allow-text") {
      const textBody = decodeText(bytes);
      if (textBody === null) return { ok: false, reason: "Rejected unknown or binary file" };
      return classifyText(textBody);
    }
    if (rule.action === "deny" && rule.textPrefix) {
      const head = latin1(bytes.subarray(0, Math.min(bytes.byteLength, rule.textPrefix.length)));
      if (head === rule.textPrefix) return { ok: false, reason: `Rejected encrypted payload: ${rule.id}` };
      continue;
    }
    if (!("bytes" in rule) || !rule.bytes) continue;
    const at = "at" in rule && typeof rule.at === "number" ? rule.at : 0;
    if (!matches(bytes, rule.bytes, at)) continue;
    if (rule.action === "deny" && rule.and && !matches(bytes, rule.and.bytes, rule.and.at)) continue;
    if (rule.action === "deny") return { ok: false, reason: `Rejected ${rule.group}: ${rule.id}` };
    if (rule.action === "allow" && rule.kind === "pdf") return sniffPdf(bytes);
  }
  return { ok: false, reason: "Rejected unknown or binary file" };
}

function matches(bytes: Uint8Array, magic: number[], at: number): boolean {
  if (at < 0 || at + magic.length > bytes.byteLength) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[at + i] !== magic[i]) return false;
  return true;
}

function hasTarMagic(bytes: Uint8Array): boolean {
  return matches(bytes, text("ustar"), 257);
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

function decodeText(bytes: Uint8Array): string | null {
  let view = bytes;
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) view = bytes.subarray(3);
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(view);
  } catch {
    return null;
  }
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code === 0) return null;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return null;
  }
  return value;
}

function hasLongBase64(value: string): boolean {
  const match = /[A-Za-z0-9+/]{256,}={0,2}/.exec(value);
  if (!match) return false;
  const run = match[0].replace(/=+$/, "");
  let classes = 0;
  if (/[A-Z]/.test(run)) classes += 1;
  if (/[a-z]/.test(run)) classes += 1;
  if (/[0-9]/.test(run)) classes += 1;
  if (/[+\/]/.test(run)) classes += 1;
  return classes >= 3;
}

function hasLongHex(value: string): boolean {
  const match = /[0-9a-fA-F]{256,}/.exec(value);
  if (!match) return false;
  const run = match[0];
  return /[0-9]/.test(run) && /[a-f]/i.test(run) && new Set(run.toLowerCase()).size >= 8;
}

function classifyText(value: string): Sniff {
  for (const marker of ARMOUR) {
    if (value.includes(marker)) return { ok: false, reason: "Rejected encrypted payload" };
  }
  if (hasLongBase64(value) || hasLongHex(value)) return { ok: false, reason: "Rejected encoded payload" };
  const trimmed = value.trim();
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length <= 1_000_000) {
    try {
      JSON.parse(trimmed);
      return { ok: true, kind: "json", mediaType: "application/json", inline: true };
    } catch {
      // Markdown and notes can start with a brace. Keep them as text.
    }
  }
  return { ok: true, kind: "text", mediaType: "text/plain; charset=utf-8", inline: true };
}

function sniffPdf(bytes: Uint8Array): Sniff {
  const body = latin1(bytes);
  const eof = body.lastIndexOf("%%EOF");
  if (eof === -1) return { ok: false, reason: "Rejected PDF without a trailer" };
  if (/[^\t\n\r\f ]/.test(body.slice(eof + "%%EOF".length))) return { ok: false, reason: "Rejected PDF without a trailer" };
  for (const magic of PDF_DENY) {
    if (magic.length < 4) continue;
    if (indexOf(bytes, magic, 0) !== -1) return { ok: false, reason: "Rejected PDF with an embedded payload" };
  }
  const names = decodePdfHashes(body);
  for (const token of PDF_TOKENS) {
    if (hasPdfName(names, token)) return { ok: false, reason: "Rejected PDF with an active feature" };
  }
  return { ok: true, kind: "pdf", mediaType: "application/pdf", inline: false };
}

function decodePdfHashes(body: string): string {
  return body.replace(/#([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function hasPdfName(body: string, token: string): boolean {
  let from = 0;
  while (from < body.length) {
    const at = body.indexOf(token, from);
    if (at === -1) return false;
    const next = body[at + token.length] ?? "";
    if (!/[A-Za-z0-9]/.test(next)) return true;
    from = at + token.length;
  }
  return false;
}

function indexOf(hay: Uint8Array, needle: number[], from: number): number {
  outer: for (let i = from; i + needle.length <= hay.byteLength; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function safeFilename(key: string): string {
  const base = key.split("/").pop() || "file";
  const cleaned = base.replace(/[^\w.\- ()[\]]+/g, "_").slice(0, 120);
  return cleaned || "file";
}

export function contentDisposition(filename: string, inline: boolean): string {
  const star = encodeURIComponent(filename);
  return `${inline ? "inline" : "attachment"}; filename="${filename.replaceAll('"', "")}"; filename*=UTF-8''${star}`;
}
