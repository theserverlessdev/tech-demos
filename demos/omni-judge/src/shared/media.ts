import { LIMITS } from "./limits";
import type { Modality } from "./types";

export type Sniffed =
  | { ok: true; kind: Modality; contentType: string; durationMs: number | null }
  | { ok: false; message: string };

const JPEG = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const PNG = (b: Uint8Array) =>
  b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a;
const WEBP = (b: Uint8Array) =>
  b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
const WAV = (b: Uint8Array) =>
  b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45;
const EBML = (b: Uint8Array) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
const FTYP = (b: Uint8Array) => b.length > 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70;

function u16(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
}
function u32(b: Uint8Array, o: number): number {
  return (u16(b, o) + (u16(b, o + 2) << 16)) >>> 0;
}

function readWav(bytes: Uint8Array): { durationMs: number } | null {
  if (!WAV(bytes) || bytes.length < 44) return null;
  let format = 0;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let dataBytes = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);
    const size = u32(bytes, offset + 4);
    const start = offset + 8;
    if (size < 0 || start + size > bytes.length + 1) break;
    if (id === "fmt " && size >= 16) {
      format = u16(bytes, start);
      channels = u16(bytes, start + 2);
      rate = u32(bytes, start + 4);
      bits = u16(bytes, start + 14);
    } else if (id === "data") {
      dataBytes = size;
      break;
    }
    offset = start + size + (size % 2);
  }
  if (format !== 1 || channels < 1 || channels > 2 || bits !== 8 && bits !== 16) return null;
  if (rate < 8_000 || rate > 48_000 || dataBytes < 1) return null;
  const bytesPerSecond = rate * channels * (bits / 8);
  if (bytesPerSecond <= 0) return null;
  return { durationMs: Math.round((dataBytes / bytesPerSecond) * 1000) };
}

const BITRATE_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATE_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const BITRATE_V1_L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0];
const BITRATE_V2_L2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];

function bitrateKbps(version: number, layer: number, index: number): number {
  const mpeg1 = version === 3;
  if (layer === 3) return 0;
  const table = layer === 1 ? (mpeg1 ? BITRATE_V1_L3 : BITRATE_V2_L3) : mpeg1 ? BITRATE_V1_L2 : BITRATE_V2_L2;
  return table[index] ?? 0;
}

function sampleRateHz(version: number, index: number): number {
  const table = version === 3 ? [44100, 48000, 32000] : version === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000];
  return table[index] ?? 0;
}

function skipId3(bytes: Uint8Array): number {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const size = ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
  return 10 + size;
}

type Frame = { version: number; layer: number; bitrate: number; rate: number; size: number; samples: number };

function frameAt(bytes: Uint8Array, offset: number): Frame | null {
  if (offset + 4 > bytes.length) return null;
  const b0 = bytes[offset] ?? 0;
  const b1 = bytes[offset + 1] ?? 0;
  const b2 = bytes[offset + 2] ?? 0;
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 0x3;
  const layer = (b1 >> 1) & 0x3;
  if (version === 1 || layer === 0) return null;
  const bitrateIndex = (b2 >> 4) & 0xf;
  const rateIndex = (b2 >> 2) & 0x3;
  const padding = (b2 >> 1) & 0x1;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const kbps = bitrateKbps(version, layer, bitrateIndex);
  const rate = sampleRateHz(version, rateIndex);
  if (!kbps || !rate) return null;
  const samples = layer === 1 ? (version === 3 ? 1152 : 576) : layer === 2 ? 1152 : 384;
  const size = layer === 3 ? Math.floor((12 * kbps * 1000) / rate + padding) * 4 : Math.floor((samples / 8 * kbps * 1000) / rate + padding);
  if (size < 4 || offset + size > bytes.length + 4) return null;
  return { version, layer, bitrate: kbps * 1000, rate, size, samples };
}

function readMp3(bytes: Uint8Array): { durationMs: number } | null {
  const start = skipId3(bytes);
  if (start < 0 || start >= bytes.length) return null;
  let offset = start;
  let frame: Frame | null = null;
  const scanEnd = Math.min(bytes.length - 4, start + 4096);
  for (let i = start; i < scanEnd; i++) {
    frame = frameAt(bytes, i);
    if (frame) {
      offset = i;
      break;
    }
  }
  if (!frame) return null;
  const head = bytes.subarray(offset, Math.min(bytes.length, offset + frame.size));
  const xingAt = indexOfAscii(head, "Xing") >= 0 ? indexOfAscii(head, "Xing") : indexOfAscii(head, "Info");
  if (xingAt >= 0 && xingAt + 8 < head.length) {
    const flags = u32be(head, xingAt + 4);
    if ((flags & 1) === 1 && xingAt + 12 <= head.length) {
      const frames = u32be(head, xingAt + 8);
      if (frames > 0) return { durationMs: Math.round((frames * frame.samples * 1000) / frame.rate) };
    }
  }
  let frames = 0;
  let cursor = offset;
  let guard = 0;
  while (cursor + 4 <= bytes.length && guard < 20_000) {
    const next = frameAt(bytes, cursor);
    if (!next) break;
    frames += 1;
    cursor += next.size;
    guard += 1;
  }
  if (frames < 1) return null;
  if (cursor < bytes.length - 128 && frame.bitrate > 0) {
    const seconds = ((bytes.length - offset) * 8) / frame.bitrate;
    return { durationMs: Math.round(seconds * 1000) };
  }
  return { durationMs: Math.round((frames * frame.samples * 1000) / frame.rate) };
}

function indexOfAscii(bytes: Uint8Array, text: string): number {
  const needle = [...text].map((ch) => ch.charCodeAt(0));
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function u32be(bytes: Uint8Array, o: number): number {
  return ((bytes[o] ?? 0) << 24) | ((bytes[o + 1] ?? 0) << 16) | ((bytes[o + 2] ?? 0) << 8) | (bytes[o + 3] ?? 0);
}

function readId(bytes: Uint8Array, offset: number): { id: number; next: number } | null {
  if (offset >= bytes.length) return null;
  const first = bytes[offset] ?? 0;
  let length = 1;
  let mask = 0x80;
  while (length <= 4 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 4 || offset + length > bytes.length) return null;
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + (bytes[offset + i] ?? 0);
  return { id, next: offset + length };
}

function readSize(bytes: Uint8Array, offset: number): { value: number; next: number; unknown: boolean } | null {
  if (offset >= bytes.length) return null;
  const first = bytes[offset] ?? 0;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8 || offset + length > bytes.length) return null;
  let value = first & (mask - 1);
  let unknown = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    const byte = bytes[offset + i] ?? 0;
    value = value * 256 + byte;
    if (byte !== 0xff) unknown = false;
  }
  if (!Number.isSafeInteger(value)) return null;
  return { value, next: offset + length, unknown };
}

function readUint(bytes: Uint8Array, start: number, end: number): number | null {
  if (end <= start || end - start > 8) return null;
  let value = 0;
  for (let i = start; i < end; i++) value = value * 256 + (bytes[i] ?? 0);
  return value;
}

function readFloat(bytes: Uint8Array, start: number, end: number): number | null {
  const size = end - start;
  if (size !== 4 && size !== 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, size);
  const value = size === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false);
  return Number.isFinite(value) ? value : null;
}

const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMECODE = 0xe7;

function readWebm(bytes: Uint8Array): { durationMs: number } | null {
  if (!EBML(bytes)) return null;
  let scale = 1_000_000;
  let duration: number | null = null;
  let maxTimecode = 0;
  const visit = (start: number, end: number, depth: number) => {
    let offset = start;
    while (offset + 2 <= end && depth < 6) {
      const id = readId(bytes, offset);
      if (!id) break;
      const size = readSize(bytes, id.next);
      if (!size) break;
      const dataEnd = size.unknown ? end : size.next + size.value;
      if (dataEnd < size.next || dataEnd > end) break;
      if (id.id === ID_TIMECODE_SCALE) {
        const value = readUint(bytes, size.next, dataEnd);
        if (value && value > 0) scale = value;
      } else if (id.id === ID_DURATION) {
        const value = readFloat(bytes, size.next, dataEnd);
        if (value !== null && value > 0) duration = value;
      } else if (id.id === ID_TIMECODE && depth > 2) {
        const value = readUint(bytes, size.next, dataEnd);
        if (value !== null) maxTimecode = Math.max(maxTimecode, value);
      } else if (id.id === ID_CLUSTER) {
        const headEnd = Math.min(dataEnd, size.next + 32);
        visit(size.next, headEnd, depth + 1);
      } else if (id.id === ID_SEGMENT || id.id === ID_INFO || size.value < 64) {
        visit(size.next, dataEnd, depth + 1);
      }
      if (size.unknown) break;
      offset = dataEnd;
    }
  };
  visit(0, bytes.length, 0);
  if (duration !== null) return { durationMs: Math.round((duration * scale) / 1_000_000) };
  if (maxTimecode > 0) return { durationMs: Math.round((maxTimecode * scale) / 1_000_000) };
  return null;
}

function readAtom(bytes: Uint8Array, offset: number): { type: string; start: number; end: number; header: number } | null {
  if (offset + 8 > bytes.length) return null;
  let size = u32be(bytes, offset);
  const type = String.fromCharCode(bytes[offset + 4] ?? 0, bytes[offset + 5] ?? 0, bytes[offset + 6] ?? 0, bytes[offset + 7] ?? 0);
  let header = 8;
  if (size === 1) {
    if (offset + 16 > bytes.length) return null;
    const hi = u32be(bytes, offset + 8);
    const lo = u32be(bytes, offset + 12);
    size = hi * 2 ** 32 + lo;
    header = 16;
  } else if (size === 0) {
    size = bytes.length - offset;
  }
  if (size < header || offset + size > bytes.length) return null;
  return { type, start: offset + header, end: offset + size, header };
}

function readMp4(bytes: Uint8Array): { durationMs: number } | null {
  if (!FTYP(bytes)) return null;
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const atom = readAtom(bytes, offset);
    if (!atom) break;
    if (atom.type === "moov") {
      let child = atom.start;
      while (child + 8 <= atom.end) {
        const inner = readAtom(bytes, child);
        if (!inner) break;
        if (inner.type === "mvhd") {
          const version = bytes[inner.start] ?? 0;
          if (version === 0 && inner.start + 20 <= inner.end) {
            const timescale = u32be(bytes, inner.start + 12);
            const duration = u32be(bytes, inner.start + 16);
            if (timescale > 0) return { durationMs: Math.round((duration * 1000) / timescale) };
          }
          if (version === 1 && inner.start + 32 <= inner.end) {
            const timescale = u32be(bytes, inner.start + 20);
            const hi = u32be(bytes, inner.start + 24);
            const lo = u32be(bytes, inner.start + 28);
            const duration = hi * 2 ** 32 + lo;
            if (timescale > 0) return { durationMs: Math.round((duration * 1000) / timescale) };
          }
          return null;
        }
        child = inner.end;
      }
    }
    offset = atom.end;
  }
  return null;
}

function capped(kind: Modality, bytes: number, durationMs: number | null): Sniffed | null {
  if (kind === "image") {
    if (bytes > LIMITS.maxImageBytes) return { ok: false, message: "Images must be 2 MB or smaller." };
    return null;
  }
  if (durationMs === null || durationMs <= 0) {
    return { ok: false, message: kind === "audio" ? "This audio has no readable duration." : "This video has no readable duration." };
  }
  if (kind === "audio") {
    if (bytes > LIMITS.maxAudioBytes) return { ok: false, message: "Audio must be 1.5 MB or smaller." };
    if (durationMs > LIMITS.maxAudioMs) return { ok: false, message: "Audio must be 15 seconds or shorter." };
  }
  if (kind === "video") {
    if (bytes > LIMITS.maxVideoBytes) return { ok: false, message: "Video must be 6 MB or smaller." };
    if (durationMs > LIMITS.maxVideoMs) return { ok: false, message: "Video must be 10 seconds or shorter." };
  }
  return null;
}

/** The declared Content-Type is ignored. Caps come from the bytes. */
export function sniffMedia(bytes: Uint8Array): Sniffed {
  if (bytes.length > LIMITS.maxVideoBytes) return { ok: false, message: "That file is larger than 6 MB." };
  if (PNG(bytes)) {
    const over = capped("image", bytes.length, null);
    return over ?? { ok: true, kind: "image", contentType: "image/png", durationMs: null };
  }
  if (JPEG(bytes)) {
    const over = capped("image", bytes.length, null);
    return over ?? { ok: true, kind: "image", contentType: "image/jpeg", durationMs: null };
  }
  if (WEBP(bytes)) {
    const over = capped("image", bytes.length, null);
    return over ?? { ok: true, kind: "image", contentType: "image/webp", durationMs: null };
  }
  if (WAV(bytes)) {
    const parsed = readWav(bytes);
    if (!parsed) return { ok: false, message: "Use a PCM WAV (8-bit or 16-bit, 8–48 kHz)." };
    const over = capped("audio", bytes.length, parsed.durationMs);
    return over ?? { ok: true, kind: "audio", contentType: "audio/wav", durationMs: parsed.durationMs };
  }
  if (EBML(bytes)) {
    const parsed = readWebm(bytes);
    if (!parsed) return { ok: false, message: "This video has no readable duration." };
    const over = capped("video", bytes.length, parsed.durationMs);
    return over ?? { ok: true, kind: "video", contentType: "video/webm", durationMs: parsed.durationMs };
  }
  if (FTYP(bytes)) {
    const parsed = readMp4(bytes);
    if (!parsed) return { ok: false, message: "This video has no readable duration." };
    const over = capped("video", bytes.length, parsed.durationMs);
    return over ?? { ok: true, kind: "video", contentType: "video/mp4", durationMs: parsed.durationMs };
  }
  const mp3 = readMp3(bytes);
  if (mp3) {
    const over = capped("audio", bytes.length, mp3.durationMs);
    return over ?? { ok: true, kind: "audio", contentType: "audio/mpeg", durationMs: mp3.durationMs };
  }
  return { ok: false, message: "Use a PNG, JPEG, or WebP image, a WAV or MP3, or an MP4 or WebM video." };
}
