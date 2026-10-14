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
  // Xing/Info and a bitrate-times-length guess are both header fields a caller can set.
  // The cap uses the frames that are actually in the file.
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
  return { durationMs: Math.round((frames * frame.samples * 1000) / frame.rate) };
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

const ID_TIMECODE = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK = 0xa1;
const ID_BLOCK_GROUP = 0xa0;
const CLUSTER_ID = Uint8Array.of(0x1f, 0x43, 0xb6, 0x75);

function indexOfBytes(bytes: Uint8Array, needle: Uint8Array, from: number): number {
  const start = Math.max(0, from);
  outer: for (let i = start; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function readTimecodeScale(bytes: Uint8Array): number {
  const at = indexOfBytes(bytes, Uint8Array.of(0x2a, 0xd7, 0xb1), 0);
  if (at < 0) return 1_000_000;
  const size = readSize(bytes, at + 3);
  if (!size || size.unknown) return 1_000_000;
  const value = readUint(bytes, size.next, size.next + size.value);
  return value && value > 0 ? value : 1_000_000;
}

/** Relative timecode is a signed int16 after the track-number vint. */
function blockRel(bytes: Uint8Array, start: number, end: number): number | null {
  const track = readSize(bytes, start);
  if (!track || track.next + 2 > end) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + track.next, 2);
  return view.getInt16(0, false);
}

/**
 * Chrome MediaRecorder writes Cluster at segment depth with an unknown size.
 * Timecode lives in that cluster (depth >= 2 from the file root). The Duration
 * element is ignored: the cap is the last block timecode.
 */
function readWebm(bytes: Uint8Array): { durationMs: number } | null {
  if (!EBML(bytes)) return null;
  const scale = readTimecodeScale(bytes);
  let maxTs = 0;
  let found = false;
  let cursor = 0;
  while (cursor < bytes.length) {
    const at = indexOfBytes(bytes, CLUSTER_ID, cursor);
    if (at < 0) break;
    const size = readSize(bytes, at + CLUSTER_ID.length);
    if (!size) {
      cursor = at + CLUSTER_ID.length;
      continue;
    }
    let dataEnd: number;
    if (size.unknown) {
      const next = indexOfBytes(bytes, CLUSTER_ID, size.next);
      dataEnd = next < 0 ? bytes.length : next;
    } else {
      dataEnd = Math.min(bytes.length, size.next + size.value);
    }
    if (dataEnd < size.next) {
      cursor = at + CLUSTER_ID.length;
      continue;
    }
    let clusterTc = 0;
    let offset = size.next;
    while (offset + 2 <= dataEnd) {
      const id = readId(bytes, offset);
      if (!id || id.next > dataEnd) break;
      const child = readSize(bytes, id.next);
      if (!child) break;
      const childEnd = child.unknown ? dataEnd : child.next + child.value;
      if (childEnd < child.next || childEnd > dataEnd) break;
      if (id.id === ID_TIMECODE) {
        const value = readUint(bytes, child.next, childEnd);
        if (value !== null) clusterTc = value;
      } else if (id.id === ID_SIMPLE_BLOCK || id.id === ID_BLOCK) {
        const rel = blockRel(bytes, child.next, childEnd);
        if (rel !== null) {
          found = true;
          maxTs = Math.max(maxTs, clusterTc + rel);
        }
      } else if (id.id === ID_BLOCK_GROUP && !child.unknown) {
        let inner = child.next;
        while (inner + 2 <= childEnd) {
          const blockId = readId(bytes, inner);
          if (!blockId || blockId.next > childEnd) break;
          const blockSize = readSize(bytes, blockId.next);
          if (!blockSize || blockSize.unknown) break;
          const blockEnd = blockSize.next + blockSize.value;
          if (blockEnd > childEnd) break;
          if (blockId.id === ID_BLOCK || blockId.id === ID_SIMPLE_BLOCK) {
            const rel = blockRel(bytes, blockSize.next, blockEnd);
            if (rel !== null) {
              found = true;
              maxTs = Math.max(maxTs, clusterTc + rel);
            }
          }
          inner = blockEnd;
        }
      }
      if (child.unknown) break;
      offset = childEnd;
    }
    cursor = Math.max(dataEnd, at + CLUSTER_ID.length);
  }
  if (!found || maxTs <= 0) return null;
  const durationMs = Math.round((maxTs * scale) / 1_000_000);
  return durationMs > 0 ? { durationMs } : null;
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

const MP4_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "mvex", "moof", "traf"]);

function ticksToMs(ticks: number, scale: number): number {
  if (ticks <= 0 || scale <= 0) return 0;
  return Math.round((ticks * 1000) / scale);
}

/**
 * mvhd.duration is not used. Safari's fMP4 leaves it at 0.
 * The cap is the longest of mehd (movie timescale), the stts sample table,
 * and the trun sample durations (mdhd timescale).
 */
function readMp4(bytes: Uint8Array): { durationMs: number } | null {
  if (!FTYP(bytes)) return null;
  let movieScale = 0;
  let mehdTicks = 0;
  let currentTrack = 0;
  const trackScale = new Map<number, number>();
  const sttsTicks = new Map<number, number>();
  const trunTicks = new Map<number, number>();

  const walk = (start: number, end: number, depth: number): void => {
    let offset = start;
    let trafTrack = 0;
    let defaultDuration = 0;
    while (offset + 8 <= end && depth < 8) {
      const box = readAtom(bytes, offset);
      if (!box) break;
      const version = bytes[box.start] ?? 0;
      if (box.type === "mvhd") {
        const scaleAt = version === 1 ? 20 : 12;
        if (box.start + scaleAt + 4 <= box.end) movieScale = u32be(bytes, box.start + scaleAt);
      } else if (box.type === "tkhd") {
        const idAt = version === 1 ? 20 : 12;
        if (box.start + idAt + 4 <= box.end) currentTrack = u32be(bytes, box.start + idAt);
      } else if (box.type === "mdhd" && currentTrack > 0) {
        const scaleAt = version === 1 ? 20 : 12;
        if (box.start + scaleAt + 4 <= box.end) trackScale.set(currentTrack, u32be(bytes, box.start + scaleAt));
      } else if (box.type === "stts" && currentTrack > 0) {
        const count = u32be(bytes, box.start + 4);
        let ticks = 0;
        let cursor = box.start + 8;
        const entries = Math.min(count, 100_000);
        for (let i = 0; i < entries && cursor + 8 <= box.end; i++) {
          ticks += u32be(bytes, cursor) * u32be(bytes, cursor + 4);
          cursor += 8;
        }
        sttsTicks.set(currentTrack, (sttsTicks.get(currentTrack) ?? 0) + ticks);
      } else if (box.type === "mehd") {
        if (version === 1 && box.start + 12 <= box.end) mehdTicks = u32be(bytes, box.start + 4) * 2 ** 32 + u32be(bytes, box.start + 8);
        else if (box.start + 8 <= box.end) mehdTicks = u32be(bytes, box.start + 4);
      } else if (box.type === "tfhd") {
        const flags = u32be(bytes, box.start) & 0xffffff;
        if (box.start + 8 <= box.end) trafTrack = u32be(bytes, box.start + 4);
        let cursor = box.start + 8;
        if (flags & 0x000001) cursor += 8;
        if (flags & 0x000002) cursor += 4;
        if ((flags & 0x000008) !== 0 && cursor + 4 <= box.end) defaultDuration = u32be(bytes, cursor);
      } else if (box.type === "trun" && trafTrack > 0) {
        const flags = u32be(bytes, box.start) & 0xffffff;
        const samples = u32be(bytes, box.start + 4);
        let cursor = box.start + 8;
        if (flags & 0x000001) cursor += 4;
        if (flags & 0x000004) cursor += 4;
        const sampleBytes = (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
        let ticks = 0;
        if ((flags & 0x100) !== 0) {
          const n = Math.min(samples, 200_000);
          for (let i = 0; i < n && cursor + 4 <= box.end; i++) {
            ticks += u32be(bytes, cursor);
            cursor += sampleBytes || 4;
          }
        } else if (defaultDuration > 0) {
          ticks = samples * defaultDuration;
        }
        trunTicks.set(trafTrack, (trunTicks.get(trafTrack) ?? 0) + ticks);
      } else if (MP4_CONTAINERS.has(box.type)) {
        const trackBefore = currentTrack;
        walk(box.start, box.end, depth + 1);
        if (box.type === "trak") currentTrack = trackBefore;
      }
      offset = box.end;
    }
  };
  walk(0, bytes.length, 0);

  let best = ticksToMs(mehdTicks, movieScale);
  for (const [id, ticks] of sttsTicks) best = Math.max(best, ticksToMs(ticks, trackScale.get(id) ?? 0));
  for (const [id, ticks] of trunTicks) best = Math.max(best, ticksToMs(ticks, trackScale.get(id) ?? movieScale));
  return best > 0 ? { durationMs: best } : null;
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
    if (durationMs > LIMITS.maxVideoMs + LIMITS.videoSlackMs) return { ok: false, message: "Video must be 10 seconds or shorter." };
  }
  return null;
}

const MAX_PIXELS = LIMITS.maxImagePixels;

function pngPixels(bytes: Uint8Array): number | null {
  if (bytes.length < 24) return null;
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  if (width < 1 || height < 1) return null;
  const pixels = width * height;
  return Number.isSafeInteger(pixels) ? pixels : null;
}

function jpegPixels(bytes: Uint8Array): number | null {
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset] ?? 0;
    offset += 1;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (offset + 1 >= bytes.length) return null;
    const length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
    const sof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (sof) {
      if (offset + 7 >= bytes.length) return null;
      const height = ((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0);
      const width = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0);
      if (width < 1 || height < 1) return null;
      const pixels = width * height;
      return Number.isSafeInteger(pixels) ? pixels : null;
    }
    if (marker === 0xda) return null;
    if (length < 2 || offset + length > bytes.length) return null;
    offset += length;
  }
  return null;
}

function webpPixels(bytes: Uint8Array): number | null {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const tag = String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);
    const size = u32(bytes, offset + 4);
    const data = offset + 8;
    if (size < 0 || data + size > bytes.length + 1) return null;
    if (tag === "VP8X" && size >= 10) {
      const width = 1 + ((bytes[data + 4] ?? 0) | ((bytes[data + 5] ?? 0) << 8) | ((bytes[data + 6] ?? 0) << 16));
      const height = 1 + ((bytes[data + 7] ?? 0) | ((bytes[data + 8] ?? 0) << 8) | ((bytes[data + 9] ?? 0) << 16));
      const pixels = width * height;
      return Number.isSafeInteger(pixels) ? pixels : null;
    }
    if (tag === "VP8 " && size >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) {
      const width = u16(bytes, data + 6) & 0x3fff;
      const height = u16(bytes, data + 8) & 0x3fff;
      if (width < 1 || height < 1) return null;
      return width * height;
    }
    if (tag === "VP8L" && size >= 5 && bytes[data] === 0x2f) {
      const b1 = bytes[data + 1] ?? 0;
      const b2 = bytes[data + 2] ?? 0;
      const b3 = bytes[data + 3] ?? 0;
      const b4 = bytes[data + 4] ?? 0;
      const width = 1 + (((b2 & 0x3f) << 8) | b1);
      const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
      return width * height;
    }
    offset = data + size + (size % 2);
  }
  return null;
}

function imageTooBig(pixels: number | null): Sniffed | null {
  if (pixels === null) return { ok: false, message: "This image has no readable size." };
  if (pixels > MAX_PIXELS) return { ok: false, message: "Images must be 16 megapixels or smaller." };
  return null;
}

/** The declared Content-Type is ignored. Caps come from the bytes. */
export function sniffMedia(bytes: Uint8Array): Sniffed {
  if (bytes.length > LIMITS.maxVideoBytes) return { ok: false, message: "That file is larger than 6 MB." };
  if (PNG(bytes)) {
    const pixels = imageTooBig(pngPixels(bytes));
    if (pixels) return pixels;
    const over = capped("image", bytes.length, null);
    return over ?? { ok: true, kind: "image", contentType: "image/png", durationMs: null };
  }
  if (JPEG(bytes)) {
    const pixels = imageTooBig(jpegPixels(bytes));
    if (pixels) return pixels;
    const over = capped("image", bytes.length, null);
    return over ?? { ok: true, kind: "image", contentType: "image/jpeg", durationMs: null };
  }
  if (WEBP(bytes)) {
    const pixels = imageTooBig(webpPixels(bytes));
    if (pixels) return pixels;
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
