import { MAX_FILE_BYTES } from "./constants";

/**
 * One list. `sniff` walks it from top to bottom and stops at the first match.
 * Office packages are ZIP containers, so ZIP is denied unless the names are
 * a Word, Excel, or PowerPoint package with no media parts.
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
  | { id: "zip"; action: "office-or-deny"; group: "archive"; bytes: number[] }
  | { id: "pdf"; action: "allow"; kind: "pdf"; bytes: number[] }
  | { id: "ole"; action: "allow-ole"; kind: "ole"; bytes: number[] }
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
  { id: "zip", action: "office-or-deny", group: "archive", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { id: "zip-empty", action: "deny", group: "archive", bytes: [0x50, 0x4b, 0x05, 0x06] },
  { id: "pdf", action: "allow", kind: "pdf", bytes: text("%PDF-") },
  { id: "ole", action: "allow-ole", kind: "ole", bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  { id: "pgp", action: "deny", group: "encrypted", textPrefix: "-----BEGIN PGP" },
  { id: "age", action: "deny", group: "encrypted", textPrefix: "age-encryption.org/" },
  { id: "openssl", action: "deny", group: "encrypted", textPrefix: "Salted__" },
  { id: "utf8-text", action: "allow-text", kind: "text" },
];

const MEDIA_ENTRY =
  /(^|\/)(media\/)|(\.(png|jpe?g|gif|webp|bmp|ico|avif|heic|mp4|m4v|mov|webm|avi|mkv|mp3|wav|ogg|flac|aac|m4a|zip|7z|rar|gz|tgz|tar|exe|dll|wasm|bin))$/i;

const EMBEDDED_MEDIA: number[][] = [
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  [0xff, 0xd8, 0xff],
  text("GIF87a"),
  text("GIF89a"),
  text("WEBP"),
];

export type Sniff =
  | { ok: true; kind: "text" | "json" | "pdf" | "ooxml" | "ole"; mediaType: string; inline: boolean }
  | { ok: false; reason: string };

export function sniff(bytes: Uint8Array): Sniff {
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
    if (rule.action === "office-or-deny") return sniffOffice(bytes);
    if (rule.action === "allow" && rule.kind === "pdf") {
      return { ok: true, kind: "pdf", mediaType: "application/pdf", inline: true };
    }
    if (rule.action === "allow-ole") return sniffOle(bytes);
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
    value = new TextDecoder("utf-8", { fatal: true }).decode(view);
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

function classifyText(value: string): Sniff {
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

function sniffOle(bytes: Uint8Array): Sniff {
  for (const magic of EMBEDDED_MEDIA) {
    if (indexOf(bytes, magic, 8) !== -1) {
      return { ok: false, reason: "Rejected office document with an embedded image" };
    }
  }
  return { ok: true, kind: "ole", mediaType: "application/vnd.ms-office", inline: false };
}

function sniffOffice(bytes: Uint8Array): Sniff {
  const walked = walkZip(bytes);
  if (!walked.ok) return { ok: false, reason: walked.reason };
  const names = walked.names;
  if (!names.includes("[Content_Types].xml")) return { ok: false, reason: "Rejected archive: zip" };
  const word = names.some((name) => name.startsWith("word/"));
  const sheet = names.some((name) => name.startsWith("xl/"));
  const slides = names.some((name) => name.startsWith("ppt/"));
  if (!word && !sheet && !slides) return { ok: false, reason: "Rejected archive: zip" };
  if (names.some((name) => name.split("/").includes("..") || name.startsWith("/") || MEDIA_ENTRY.test(name))) {
    return { ok: false, reason: "Rejected office document with media or a nested archive" };
  }
  const mediaType = word
    ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    : sheet
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  return { ok: true, kind: "ooxml", mediaType, inline: false };
}

function walkZip(bytes: Uint8Array): { ok: true; names: string[] } | { ok: false; reason: string } {
  const names: string[] = [];
  let offset = 0;
  while (offset + 30 <= bytes.byteLength) {
    const sig = readU32(bytes, offset);
    if (sig === 0x02014b50 || sig === 0x06054b50) break;
    if (sig !== 0x04034b50) return { ok: false, reason: "Rejected archive: zip" };
    const flags = readU16(bytes, offset + 6);
    const compSize = readU32(bytes, offset + 18);
    const nameLen = readU16(bytes, offset + 26);
    const extraLen = readU16(bytes, offset + 28);
    if (flags & 1) return { ok: false, reason: "Rejected encrypted archive" };
    if (compSize === 0xffffffff) return { ok: false, reason: "Rejected archive: zip64" };
    const nameAt = offset + 30;
    if (nameAt + nameLen + extraLen > bytes.byteLength) return { ok: false, reason: "Rejected archive: zip" };
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(nameAt, nameAt + nameLen));
    } catch {
      return { ok: false, reason: "Rejected archive: zip" };
    }
    names.push(name);
    const next = nameAt + nameLen + extraLen + compSize;
    if ((flags & 8) && compSize === 0) return { ok: false, reason: "Rejected archive: zip data descriptor" };
    if (next < offset + 30 || next > bytes.byteLength) return { ok: false, reason: "Rejected archive: zip" };
    offset = next;
  }
  if (names.length === 0) return { ok: false, reason: "Rejected archive: zip" };
  return { ok: true, names };
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
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

/** Stored (method 0) ZIP. Tests and the office allow-path use this. */
export function zipStored(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const local = new Uint8Array(30 + name.byteLength + file.data.byteLength);
    writeU32(local, 0, 0x04034b50);
    writeU16(local, 8, 0);
    writeU32(local, 18, file.data.byteLength);
    writeU32(local, 22, file.data.byteLength);
    writeU16(local, 26, name.byteLength);
    local.set(name, 30);
    local.set(file.data, 30 + name.byteLength);
    locals.push(local);
    const central = new Uint8Array(46 + name.byteLength);
    writeU32(central, 0, 0x02014b50);
    writeU16(central, 10, 0);
    writeU32(central, 20, file.data.byteLength);
    writeU32(central, 24, file.data.byteLength);
    writeU16(central, 28, name.byteLength);
    writeU32(central, 42, offset);
    central.set(name, 46);
    centrals.push(central);
    offset += local.byteLength;
  }
  const centralStart = offset;
  const centralSize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new Uint8Array(22);
  writeU32(end, 0, 0x06054b50);
  writeU16(end, 8, files.length);
  writeU16(end, 10, files.length);
  writeU32(end, 12, centralSize);
  writeU32(end, 16, centralStart);
  const total = offset + centralSize + end.byteLength;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
  bytes[offset + 3] = (value >> 24) & 0xff;
}
