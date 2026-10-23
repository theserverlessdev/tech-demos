import { MAX_FILE_BYTES } from "./constants";

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
  const tail = latin1(bytes.subarray(Math.max(0, bytes.byteLength - 1024)));
  if (!tail.includes("%%EOF")) return { ok: false, reason: "Rejected PDF without a trailer" };
  for (const magic of PDF_DENY) {
    if (indexOf(bytes, magic, 0) !== -1) return { ok: false, reason: "Rejected PDF with an embedded payload" };
  }
  const body = latin1(bytes);
  for (const token of PDF_TOKENS) {
    if (hasPdfName(body, token)) return { ok: false, reason: "Rejected PDF with an active feature" };
  }
  return { ok: true, kind: "pdf", mediaType: "application/pdf", inline: false };
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
    if (!asXml(raw)) return { ok: false, reason: "Rejected office document with a non-XML part" };
  }
  const mediaType = word
    ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    : sheet
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  return { ok: true, kind: "ooxml", mediaType, inline: false };
}

type ZipEntry = { name: string; method: number; data: Uint8Array };

function walkZip(bytes: Uint8Array): { ok: true; entries: ZipEntry[] } | { ok: false; reason: string } {
  const entries: ZipEntry[] = [];
  let offset = 0;
  while (offset + 30 <= bytes.byteLength) {
    const sig = readU32(bytes, offset);
    if (sig === 0x02014b50 || sig === 0x06054b50) break;
    if (sig !== 0x04034b50) return { ok: false, reason: "Rejected archive: zip" };
    const flags = readU16(bytes, offset + 6);
    const method = readU16(bytes, offset + 8);
    const compSize = readU32(bytes, offset + 18);
    const nameLen = readU16(bytes, offset + 26);
    const extraLen = readU16(bytes, offset + 28);
    if (flags & 1) return { ok: false, reason: "Rejected encrypted archive" };
    if (compSize === 0xffffffff) return { ok: false, reason: "Rejected archive: zip64" };
    const nameAt = offset + 30;
    if (nameAt + nameLen + extraLen > bytes.byteLength) return { ok: false, reason: "Rejected archive: zip" };
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(nameAt, nameAt + nameLen));
    } catch {
      return { ok: false, reason: "Rejected archive: zip" };
    }
    const dataAt = nameAt + nameLen + extraLen;
    const next = dataAt + compSize;
    if ((flags & 8) && compSize === 0) return { ok: false, reason: "Rejected archive: zip data descriptor" };
    if (next < offset + 30 || next > bytes.byteLength) return { ok: false, reason: "Rejected archive: zip" };
    entries.push({ name, method, data: bytes.subarray(dataAt, next) });
    offset = next;
  }
  if (entries.length === 0) return { ok: false, reason: "Rejected archive: zip" };
  return { ok: true, entries };
}

function asXml(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0 || bytes.byteLength > OFFICE_PART_LIMIT) return false;
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return false;
  }
  const trimmed = value.trim();
  return trimmed.startsWith("<") && trimmed.includes(">");
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

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
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

/** Deflated (method 8) ZIP. The office allow-path requires this for a real docx. */
export async function zipDeflated(files: { name: string; data: Uint8Array }[]): Promise<Uint8Array> {
  const packed = await Promise.all(
    files.map(async (file) => ({ name: file.name, data: file.data, compressed: await deflateRaw(file.data), crc: crc32(file.data) })),
  );
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of packed) {
    const name = new TextEncoder().encode(file.name);
    const local = new Uint8Array(30 + name.byteLength + file.compressed.byteLength);
    writeU32(local, 0, 0x04034b50);
    writeU16(local, 8, 8);
    writeU32(local, 14, file.crc);
    writeU32(local, 18, file.compressed.byteLength);
    writeU32(local, 22, file.data.byteLength);
    writeU16(local, 26, name.byteLength);
    local.set(name, 30);
    local.set(file.compressed, 30 + name.byteLength);
    locals.push(local);
    const central = new Uint8Array(46 + name.byteLength);
    writeU32(central, 0, 0x02014b50);
    writeU16(central, 10, 8);
    writeU32(central, 16, file.crc);
    writeU32(central, 20, file.compressed.byteLength);
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
