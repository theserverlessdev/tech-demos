import { FINDER_MAX_BYTES, MAX_FILE_BYTES } from "./constants";

/**
 * One list. `sniff` walks it from top to bottom and stops at the first match.
 * Office packages are ZIP containers. A package is allowed only when every
 * part is `.xml` or `.rels`, inflates under a size cap, and is UTF-8 XML.
 * OLE compound documents are not accepted.
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
  { id: "ole", action: "deny", group: "binary", bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  { id: "pgp", action: "deny", group: "encrypted", textPrefix: "-----BEGIN PGP" },
  { id: "age", action: "deny", group: "encrypted", textPrefix: "age-encryption.org/" },
  { id: "age-armour", action: "deny", group: "encrypted", textPrefix: "-----BEGIN AGE ENCRYPTED FILE-----" },
  { id: "openssl", action: "deny", group: "encrypted", textPrefix: "Salted__" },
  { id: "utf8-text", action: "allow-text", kind: "text" },
];

const OFFICE_PART_LIMIT = 1024 * 1024;
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
  | { ok: true; kind: "text" | "json" | "pdf" | "ooxml"; mediaType: string; inline: boolean }
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
    if (rule.action === "office-or-deny") return sniffOffice(bytes);
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

async function sniffOffice(bytes: Uint8Array): Promise<Sniff> {
  const walked = walkZip(bytes);
  if (!walked.ok) return { ok: false, reason: walked.reason };
  const names = walked.entries.map((entry) => entry.name);
  if (!names.includes("[Content_Types].xml")) return { ok: false, reason: "Rejected archive: zip" };
  const word = names.some((name) => name.startsWith("word/"));
  const sheet = names.some((name) => name.startsWith("xl/"));
  const slides = names.some((name) => name.startsWith("ppt/"));
  if (!word && !sheet && !slides) return { ok: false, reason: "Rejected archive: zip" };
  if (names.length > 64) return { ok: false, reason: "Rejected office document with too many parts" };
  for (const name of names) {
    const lower = name.toLowerCase();
    if (name.split("/").includes("..") || name.startsWith("/") || name.includes("\\")) {
      return { ok: false, reason: "Rejected office document with media or a nested archive" };
    }
    if (!lower.endsWith(".xml") && !lower.endsWith(".rels")) {
      return { ok: false, reason: "Rejected office document with a non-XML part" };
    }
  }
  for (const entry of walked.entries) {
    let raw = entry.data;
    if (entry.method === 8) {
      const inflated = await inflateRaw(entry.data, OFFICE_PART_LIMIT);
      if (!inflated) return { ok: false, reason: "Rejected office document with an unreadable part" };
      raw = inflated;
    } else if (entry.method !== 0) {
      return { ok: false, reason: "Rejected archive: zip" };
    }
    if (!officeXml(raw)) return { ok: false, reason: "Rejected office document with a non-XML part" };
  }
  const mediaType = word
    ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    : sheet
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  return { ok: true, kind: "ooxml", mediaType, inline: false };
}

type ZipEntry = { name: string; method: number; compSize: number; uncompSize: number; crc: number; localOffset: number; data: Uint8Array };

function walkZip(bytes: Uint8Array): { ok: true; entries: ZipEntry[] } | { ok: false; reason: string } {
  if (bytes.byteLength < 22) return { ok: false, reason: "Rejected archive: zip" };
  const eocd = bytes.byteLength - 22;
  if (readU32(bytes, eocd) !== 0x06054b50) return { ok: false, reason: "Rejected archive: zip" };
  if (readU16(bytes, eocd + 20) !== 0) return { ok: false, reason: "Rejected archive: zip" };
  const total = readU16(bytes, eocd + 10);
  const cdSize = readU32(bytes, eocd + 12);
  const cdOffset = readU32(bytes, eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return { ok: false, reason: "Rejected archive: zip64" };
  if (cdOffset + cdSize + 22 !== bytes.byteLength) return { ok: false, reason: "Rejected archive: zip" };

  const entries: ZipEntry[] = [];
  let offset = 0;
  while (offset < cdOffset) {
    if (offset + 30 > bytes.byteLength || readU32(bytes, offset) !== 0x04034b50) return { ok: false, reason: "Rejected archive: zip" };
    const flags = readU16(bytes, offset + 6);
    const method = readU16(bytes, offset + 8);
    const crc = readU32(bytes, offset + 14);
    const compSize = readU32(bytes, offset + 18);
    const uncompSize = readU32(bytes, offset + 22);
    const nameLen = readU16(bytes, offset + 26);
    const extraLen = readU16(bytes, offset + 28);
    if (flags & 1) return { ok: false, reason: "Rejected encrypted archive" };
    if (flags & 8) return { ok: false, reason: "Rejected archive: zip data descriptor" };
    if (compSize === 0xffffffff || uncompSize === 0xffffffff) return { ok: false, reason: "Rejected archive: zip64" };
    const nameAt = offset + 30;
    const extraAt = nameAt + nameLen;
    if (extraAt + extraLen > cdOffset) return { ok: false, reason: "Rejected archive: zip" };
    if (hasZip64Extra(bytes.subarray(extraAt, extraAt + extraLen))) return { ok: false, reason: "Rejected archive: zip64" };
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(nameAt, nameAt + nameLen));
    } catch {
      return { ok: false, reason: "Rejected archive: zip" };
    }
    const dataAt = extraAt + extraLen;
    const next = dataAt + compSize;
    if (next < dataAt || next > cdOffset) return { ok: false, reason: "Rejected archive: zip" };
    entries.push({ name, method, compSize, uncompSize, crc, localOffset: offset, data: bytes.subarray(dataAt, next) });
    offset = next;
  }
  if (offset !== cdOffset || entries.length === 0 || entries.length !== total) return { ok: false, reason: "Rejected archive: zip" };

  let cursor = cdOffset;
  let seen = 0;
  while (cursor < cdOffset + cdSize) {
    if (cursor + 46 > cdOffset + cdSize || readU32(bytes, cursor) !== 0x02014b50) return { ok: false, reason: "Rejected archive: zip" };
    const flags = readU16(bytes, cursor + 8);
    const method = readU16(bytes, cursor + 10);
    const crc = readU32(bytes, cursor + 16);
    const compSize = readU32(bytes, cursor + 20);
    const uncompSize = readU32(bytes, cursor + 24);
    const nameLen = readU16(bytes, cursor + 28);
    const extraLen = readU16(bytes, cursor + 30);
    const commentLen = readU16(bytes, cursor + 32);
    const localOffset = readU32(bytes, cursor + 42);
    if (flags & 8) return { ok: false, reason: "Rejected archive: zip data descriptor" };
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      return { ok: false, reason: "Rejected archive: zip64" };
    }
    const nameAt = cursor + 46;
    const recordEnd = nameAt + nameLen + extraLen + commentLen;
    if (recordEnd > cdOffset + cdSize) return { ok: false, reason: "Rejected archive: zip" };
    if (hasZip64Extra(bytes.subarray(nameAt + nameLen, nameAt + nameLen + extraLen))) return { ok: false, reason: "Rejected archive: zip64" };
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(nameAt, nameAt + nameLen));
    } catch {
      return { ok: false, reason: "Rejected archive: zip" };
    }
    const local = entries[seen];
    if (
      !local ||
      local.name !== name ||
      local.method !== method ||
      local.compSize !== compSize ||
      local.uncompSize !== uncompSize ||
      local.crc !== crc ||
      local.localOffset !== localOffset
    ) {
      return { ok: false, reason: "Rejected archive: zip" };
    }
    seen += 1;
    cursor = recordEnd;
  }
  if (cursor !== cdOffset + cdSize || seen !== entries.length) return { ok: false, reason: "Rejected archive: zip" };
  return { ok: true, entries };
}

function hasZip64Extra(extra: Uint8Array): boolean {
  let offset = 0;
  while (offset + 4 <= extra.byteLength) {
    const id = readU16(extra, offset);
    const size = readU16(extra, offset + 2);
    if (id === 0x0001) return true;
    offset += 4 + size;
  }
  return false;
}

function officeXml(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0 || bytes.byteLength > OFFICE_PART_LIMIT) return false;
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("<") || !trimmed.includes(">")) return false;
  for (const marker of ARMOUR) {
    if (value.includes(marker)) return false;
  }
  return !hasLongBase64(value) && !hasLongHex(value);
}

async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array | null> {
  try {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      total += step.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(step.value);
    }
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      out.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    return out;
  } catch {
    return null;
  }
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
