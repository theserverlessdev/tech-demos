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
  let sawFmt = false;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);
    const size = u32(bytes, offset + 4);
    const start = offset + 8;
    if (size < 0 || start + size > bytes.length + 1) break;
    if (id === "fmt " && size >= 16 && !sawFmt) {
      format = u16(bytes, start);
      channels = u16(bytes, start + 2);
      rate = u32(bytes, start + 4);
      bits = u16(bytes, start + 14);
      sawFmt = true;
    } else if (id === "data") {
      if (!sawFmt) return null;
      const next = dataBytes + size;
      if (!Number.isFinite(next) || next < dataBytes) return null;
      dataBytes = next;
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
  // Xing/Info is just another frame. Junk between frames is skipped, and each
  // frame adds its own sample count at its own rate.
  let durationMs = 0;
  let frames = 0;
  let cursor = offset;
  let guard = 0;
  while (cursor + 4 <= bytes.length && guard < bytes.length) {
    const next = frameAt(bytes, cursor);
    if (!next) {
      cursor += 1;
      guard += 1;
      continue;
    }
    const frameMs = (next.samples * 1000) / next.rate;
    if (!Number.isFinite(frameMs) || frameMs < 0) return null;
    durationMs += frameMs;
    if (!Number.isFinite(durationMs) || durationMs < 0) return null;
    frames += 1;
    cursor += next.size;
    guard += 1;
    if (durationMs > LIMITS.maxAudioMs + 1e-6) {
      return { durationMs: Math.max(LIMITS.maxAudioMs + 1, durationCeil(durationMs)) };
    }
  }
  if (frames < 1 || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  return { durationMs: durationCeil(durationMs) };
}

/** Ceil only a fraction above an epsilon, so an exact whole millisecond stays exact. */
function durationCeil(ms: number): number {
  const whole = Math.floor(ms);
  if (ms - whole <= 1e-6) return whole;
  return whole + 1;
}

function u32be(bytes: Uint8Array, o: number): number {
  return (((bytes[o] ?? 0) << 24) | ((bytes[o + 1] ?? 0) << 16) | ((bytes[o + 2] ?? 0) << 8) | (bytes[o + 3] ?? 0)) >>> 0;
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
  // An all-ones vint is "unknown size" (Chrome writes 01 FF FF FF FF FF FF FF).
  // 2^56-1 is not a safe integer, so this check has to win before that test.
  if (unknown) return { value: 0, next: offset + length, unknown: true };
  if (!Number.isFinite(value) || !Number.isSafeInteger(value)) return null;
  return { value, next: offset + length, unknown: false };
}

function readUint(bytes: Uint8Array, start: number, end: number): number | null {
  if (end <= start || end - start > 8) return null;
  let value = 0;
  for (let i = start; i < end; i++) value = value * 256 + (bytes[i] ?? 0);
  return value;
}

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_CLUSTER = 0x1f43b675;
const ID_CUES = 0x1c53bb6b;
const ID_TAGS = 0x1254c367;
const ID_CHAPTERS = 0x1043a770;
const ID_ATTACHMENTS = 0x1941a469;
const ID_SEEK_HEAD = 0x114d9b74;
const ID_TRACKS = 0x1654ae6b;
/** Segment-level elements. An unknown-size cluster ends when one of these begins. */
const SEGMENT_LEVEL = new Set<number>([ID_CLUSTER, ID_CUES, ID_TAGS, ID_CHAPTERS, ID_ATTACHMENTS, ID_SEEK_HEAD, ID_INFO, ID_TRACKS]);
const MAX_STTS_ENTRIES = 100_000;
const MAX_TRUN_SAMPLES = 200_000;
const ID_TIMECODE = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK = 0xa1;
const ID_BLOCK_GROUP = 0xa0;
const MAX_BOXES = 50_000;

/** Relative timecode is a signed int16 after the track-number vint. */
function blockRel(bytes: Uint8Array, start: number, end: number): number | null {
  const track = readSize(bytes, start);
  if (!track || track.next + 2 > end) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + track.next, 2);
  return view.getInt16(0, false);
}

type Span = { min: number; max: number; found: boolean };

function noteTimestamp(span: Span, ts: number): void {
  if (!Number.isFinite(ts)) return;
  if (!span.found) {
    span.min = ts;
    span.max = ts;
    span.found = true;
    return;
  }
  if (ts < span.min) span.min = ts;
  if (ts > span.max) span.max = ts;
}

/** TimecodeScale is valid only as a child of Info. A bad value fails closed. */
function infoScale(bytes: Uint8Array, start: number, end: number): number | "absent" | "bad" {
  let offset = start;
  let scale: number | null = null;
  while (offset + 2 <= end) {
    const id = readId(bytes, offset);
    if (!id || id.next > end) break;
    const size = readSize(bytes, id.next);
    if (!size || size.unknown || size.next > end) break;
    const childEnd = size.next + size.value;
    if (childEnd < size.next || childEnd > end) break;
    if (id.id === ID_TIMECODE_SCALE) {
      const value = readUint(bytes, size.next, childEnd);
      if (value === null || value <= 0 || !Number.isFinite(value)) return "bad";
      scale = value;
    }
    offset = childEnd;
  }
  return scale === null ? "absent" : scale;
}

function readCluster(bytes: Uint8Array, start: number, end: number, span: Span): boolean {
  let clusterTc = 0;
  let offset = start;
  while (offset + 2 <= end) {
    const id = readId(bytes, offset);
    if (!id || id.next > end) return false;
    const child = readSize(bytes, id.next);
    if (!child || child.unknown || child.next > end) return false;
    const childEnd = child.next + child.value;
    if (childEnd < child.next || childEnd > end) return false;
    if (id.id === ID_TIMECODE) {
      const value = readUint(bytes, child.next, childEnd);
      if (value !== null) clusterTc = value;
    } else if (id.id === ID_SIMPLE_BLOCK || id.id === ID_BLOCK) {
      const rel = blockRel(bytes, child.next, childEnd);
      if (rel !== null) noteTimestamp(span, clusterTc + rel);
    } else if (id.id === ID_BLOCK_GROUP) {
      let inner = child.next;
      while (inner + 2 <= childEnd) {
        const blockId = readId(bytes, inner);
        if (!blockId || blockId.next > childEnd) return false;
        const blockSize = readSize(bytes, blockId.next);
        if (!blockSize || blockSize.unknown) return false;
        const blockEnd = blockSize.next + blockSize.value;
        if (blockEnd < blockSize.next || blockEnd > childEnd) return false;
        if (blockId.id === ID_BLOCK || blockId.id === ID_SIMPLE_BLOCK) {
          const rel = blockRel(bytes, blockSize.next, blockEnd);
          if (rel !== null) noteTimestamp(span, clusterTc + rel);
        }
        inner = blockEnd;
      }
    }
    offset = childEnd;
  }
  return true;
}

function restIsZero(bytes: Uint8Array, offset: number, end: number): boolean {
  for (let i = offset; i < end; i++) if ((bytes[i] ?? 0) !== 0) return false;
  return true;
}

/**
 * An unknown-size cluster is walked element by element. A raw Cluster id inside
 * a Void does not end it. The cluster ends at the next segment-level element.
 * An unknown-size child fails closed. A child cut off at the end of the file,
 * or trailing zero bytes, ends the cluster at the last complete element.
 */
function unknownClusterEnd(bytes: Uint8Array, start: number, limit: number): { at: number; sibling: boolean } | null {
  let offset = start;
  while (offset + 2 <= limit) {
    if ((bytes[offset] ?? 0) === 0) {
      if (!restIsZero(bytes, offset, limit)) return null;
      return { at: offset, sibling: false };
    }
    const id = readId(bytes, offset);
    if (!id || id.next > limit) {
      if (limit - offset < 16) return { at: offset, sibling: false };
      return null;
    }
    if (SEGMENT_LEVEL.has(id.id)) return { at: offset, sibling: true };
    const size = readSize(bytes, id.next);
    if (!size || size.next > limit) return { at: offset, sibling: false };
    if (size.unknown) return null;
    const childEnd = size.next + size.value;
    if (childEnd < size.next) return null;
    if (childEnd > limit) return { at: offset, sibling: false };
    offset = childEnd;
  }
  return { at: offset, sibling: false };
}

/**
 * Chrome MediaRecorder writes Segment and Cluster with an unknown size.
 * TimecodeScale is taken only from Segment > Info. The Duration element is
 * ignored. The cap is the span from the earliest block timecode to the latest.
 */
function readWebm(bytes: Uint8Array): { durationMs: number } | null {
  if (!EBML(bytes)) return null;
  const ebmlId = readId(bytes, 0);
  if (!ebmlId || ebmlId.id !== ID_EBML) return null;
  const ebmlSize = readSize(bytes, ebmlId.next);
  if (!ebmlSize || ebmlSize.unknown) return null;
  const ebmlEnd = ebmlSize.next + ebmlSize.value;
  if (ebmlEnd < ebmlSize.next || ebmlEnd > bytes.length) return null;
  const segmentId = readId(bytes, ebmlEnd);
  if (!segmentId || segmentId.id !== ID_SEGMENT) return null;
  const segmentSize = readSize(bytes, segmentId.next);
  if (!segmentSize) return null;
  const segmentEnd = segmentSize.unknown ? bytes.length : segmentSize.next + segmentSize.value;
  if (segmentEnd < segmentSize.next || segmentEnd > bytes.length) return null;

  let scale = 1_000_000;
  let sawInfo = false;
  const span: Span = { min: 0, max: 0, found: false };
  let offset = segmentSize.next;
  while (offset + 2 <= segmentEnd) {
    if ((bytes[offset] ?? 0) === 0) {
      if (!restIsZero(bytes, offset, segmentEnd)) return null;
      break;
    }
    const id = readId(bytes, offset);
    if (!id || id.next > segmentEnd) return null;
    const size = readSize(bytes, id.next);
    if (!size || size.next > segmentEnd) return null;
    if (id.id === ID_INFO) {
      if (sawInfo || size.unknown) return null;
      sawInfo = true;
      const infoEnd = size.next + size.value;
      if (infoEnd < size.next || infoEnd > segmentEnd) return null;
      const found = infoScale(bytes, size.next, infoEnd);
      if (found === "bad") return null;
      if (found !== "absent") scale = found;
      offset = infoEnd;
      continue;
    }
    if (id.id === ID_CLUSTER) {
      let dataEnd: number;
      let resume: number;
      if (size.unknown) {
        const bound = unknownClusterEnd(bytes, size.next, segmentEnd);
        if (!bound) return null;
        dataEnd = bound.at;
        resume = bound.sibling ? bound.at : segmentEnd;
      } else {
        dataEnd = size.next + size.value;
        if (dataEnd < size.next || dataEnd > segmentEnd) return null;
        resume = dataEnd;
      }
      if (!readCluster(bytes, size.next, dataEnd, span)) return null;
      offset = Math.max(resume, size.next);
      continue;
    }
    if (size.unknown) return null;
    const childEnd = size.next + size.value;
    if (childEnd < size.next || childEnd > segmentEnd) return null;
    offset = childEnd;
  }
  if (!span.found) return null;
  const delta = span.max - span.min;
  if (!Number.isFinite(delta) || delta <= 0 || !Number.isFinite(scale) || scale <= 0) return null;
  const durationMs = Math.round((delta * scale) / 1_000_000);
  return Number.isFinite(durationMs) && durationMs > 0 ? { durationMs } : null;
}

type Atom = { type: string; start: number; end: number };

function readAtom(bytes: Uint8Array, offset: number, parentEnd: number): Atom | null {
  const limit = Math.min(bytes.length, parentEnd);
  if (offset + 8 > limit) return null;
  let size = u32be(bytes, offset);
  const type = String.fromCharCode(bytes[offset + 4] ?? 0, bytes[offset + 5] ?? 0, bytes[offset + 6] ?? 0, bytes[offset + 7] ?? 0);
  let header = 8;
  if (size === 1) {
    if (offset + 16 > limit) return null;
    const hi = u32be(bytes, offset + 8);
    const lo = u32be(bytes, offset + 12);
    header = 16;
    // 0xFFFFFFFFFFFFFFFF is the 64-bit "extends to the parent end" size Chrome writes.
    if (hi === 0xffffffff && lo === 0xffffffff) size = limit - offset;
    else {
      const wide = hi * 2 ** 32 + lo;
      if (!Number.isFinite(wide) || wide < header) return null;
      size = wide;
    }
  } else if (size === 0) {
    size = limit - offset;
  }
  if (!Number.isFinite(size) || size < header || offset + size > limit) return null;
  return { type, start: offset + header, end: offset + size };
}

function ticksToMs(ticks: number, scale: number): number | null {
  if (!Number.isFinite(ticks) || !Number.isFinite(scale) || ticks < 0 || scale <= 0) return null;
  if (ticks === 0) return 0;
  const ms = Math.round((ticks * 1000) / scale);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms;
}

function addFinite(total: number, extra: number): number | null {
  if (!Number.isFinite(total) || !Number.isFinite(extra) || total < 0 || extra < 0) return null;
  const next = total + extra;
  if (!Number.isFinite(next) || next < 0) return null;
  return next;
}

type Trak = { id: number; scale: number; ticks: number; samples: number; elstTicks: number };
type RawTrun = { track: number; samples: number; ticks: number; needsTrex: boolean; tfdt: number | null };
type TrunAgg = { sum: number; timeline: number; timed: boolean };

/**
 * mvhd.duration is not used. Each trak keeps its own id, timescale, and sample
 * table, in whatever child order the file uses. A second moov, a repeated
 * track id, or samples with no duration fail closed. A track's media timeline
 * is its stts ticks plus every trun (tfhd, else trex), and the latest
 * tfdt + fragment duration when that reaches further. An edit list is measured
 * in the movie timescale and the track takes the longer of the two. The file
 * duration is the longest track, and mehd if that is longer.
 */
function readMp4(bytes: Uint8Array): { durationMs: number } | null {
  if (!FTYP(bytes)) return null;
  let boxes = 0;
  let failed = false;
  let moovCount = 0;
  let movieScale = 0;
  let mehdTicks = 0;
  const trexDuration = new Map<number, number>();
  const traks: Trak[] = [];
  const truns: RawTrun[] = [];

  const walk = (start: number, end: number, depth: number, visit: (box: Atom) => void): void => {
    if (depth > 8 || failed) return;
    let offset = start;
    while (offset + 8 <= end) {
      boxes += 1;
      if (boxes > MAX_BOXES) {
        failed = true;
        return;
      }
      const box = readAtom(bytes, offset, end);
      if (!box) break;
      visit(box);
      if (failed || box.end <= offset) break;
      offset = box.end;
    }
  };

  const readTrak = (start: number, end: number): void => {
    let id = 0;
    let scale = 0;
    let ticks = 0;
    let samples = 0;
    let stszSamples: number | null = null;
    let elstTicks = 0;
    let sawElst = false;
    const level = (from: number, to: number, depth: number): void => {
      walk(from, to, depth, (box) => {
        const version = bytes[box.start] ?? 0;
        if (box.type === "tkhd") {
          const idAt = version === 1 ? 20 : 12;
          if (box.start + idAt + 4 <= box.end) id = u32be(bytes, box.start + idAt);
        } else if (box.type === "mdhd") {
          const scaleAt = version === 1 ? 20 : 12;
          if (box.start + scaleAt + 4 <= box.end) scale = u32be(bytes, box.start + scaleAt);
        } else if (box.type === "stts") {
          const count = u32be(bytes, box.start + 4);
          const payload = box.end - (box.start + 8);
          if (payload < 0 || count > MAX_STTS_ENTRIES || count > Math.floor(payload / 8)) {
            failed = true;
            return;
          }
          let cursor = box.start + 8;
          for (let i = 0; i < count; i++) {
            const sampleCount = u32be(bytes, cursor);
            const delta = u32be(bytes, cursor + 4);
            cursor += 8;
            const nextSamples = addFinite(samples, sampleCount);
            const nextTicks = addFinite(ticks, sampleCount * delta);
            if (nextSamples === null || nextTicks === null) {
              failed = true;
              return;
            }
            samples = nextSamples;
            ticks = nextTicks;
          }
        } else if (box.type === "stsz") {
          if (box.start + 12 > box.end) {
            failed = true;
            return;
          }
          const sampleSize = u32be(bytes, box.start + 4);
          const sampleCount = u32be(bytes, box.start + 8);
          if (sampleSize === 0 && sampleCount > Math.floor((box.end - (box.start + 12)) / 4)) {
            failed = true;
            return;
          }
          if (stszSamples !== null && stszSamples !== sampleCount) {
            failed = true;
            return;
          }
          stszSamples = sampleCount;
        } else if (box.type === "elst") {
          const total = readElst(box);
          if (total === null || sawElst) {
            failed = true;
            return;
          }
          sawElst = true;
          elstTicks = total;
        } else if (box.type === "mdia" || box.type === "minf" || box.type === "stbl" || box.type === "edts") {
          level(box.start, box.end, depth + 1);
        }
      });
    };
    level(start, end, 0);
    if (failed) return;
    if (stszSamples !== null && stszSamples !== samples) {
      failed = true;
      return;
    }
    if (samples > 0 && (ticks <= 0 || scale <= 0 || id <= 0)) {
      failed = true;
      return;
    }
    if (id > 0) traks.push({ id, scale, ticks, samples, elstTicks });
  };

  const readElst = (box: Atom): number | null => {
    if (box.start + 8 > box.end) return null;
    const version = bytes[box.start] ?? 0;
    const count = u32be(bytes, box.start + 4);
    const stride = version === 1 ? 20 : 12;
    const payload = box.end - (box.start + 8);
    if (payload < 0 || count > 10_000 || count > Math.floor(payload / stride)) return null;
    let total = 0;
    let cursor = box.start + 8;
    for (let i = 0; i < count; i++) {
      let segment = 0;
      if (version === 1) {
        const wide = u32be(bytes, cursor) * 2 ** 32 + u32be(bytes, cursor + 4);
        if (!Number.isFinite(wide) || wide < 0) return null;
        segment = wide;
      } else {
        segment = u32be(bytes, cursor);
      }
      const next = addFinite(total, segment);
      if (next === null) return null;
      total = next;
      cursor += stride;
    }
    return total;
  };

  const readTrun = (box: Atom, track: number, tfhdPresent: boolean, tfhdDuration: number, tfdt: number | null): void => {
    const flags = u32be(bytes, box.start) & 0xffffff;
    const samples = u32be(bytes, box.start + 4);
    if (!Number.isFinite(samples) || samples < 0 || samples > MAX_TRUN_SAMPLES || track <= 0) {
      if (samples > 0) failed = true;
      return;
    }
    let ticks = 0;
    let resolved = false;
    if ((flags & 0x100) !== 0) {
      let cursor = box.start + 8;
      if (flags & 0x000001) cursor += 4;
      if (flags & 0x000004) cursor += 4;
      const sampleBytes = (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
      const stride = sampleBytes || 4;
      if (samples > Math.floor((box.end - cursor) / stride)) {
        failed = true;
        return;
      }
      for (let i = 0; i < samples; i++) {
        const next = addFinite(ticks, u32be(bytes, cursor));
        if (next === null) {
          failed = true;
          return;
        }
        ticks = next;
        cursor += stride;
      }
      resolved = true;
    } else if (tfhdPresent) {
      const next = addFinite(0, samples * tfhdDuration);
      if (next === null) {
        failed = true;
        return;
      }
      ticks = next;
      resolved = true;
    } else {
      if (samples > 0) truns.push({ track, samples, ticks: 0, needsTrex: true, tfdt });
      return;
    }
    if (samples > 0 && !resolved) {
      failed = true;
      return;
    }
    // A zero sample duration is still a placed fragment when tfdt says where it starts.
    if (samples > 0 && ticks <= 0 && tfdt === null) {
      failed = true;
      return;
    }
    if (samples > 0) truns.push({ track, samples, ticks, needsTrex: false, tfdt });
  };

  walk(0, bytes.length, 0, (box) => {
    if (box.type === "moov") {
      moovCount += 1;
      if (moovCount > 1) {
        failed = true;
        return;
      }
      walk(box.start, box.end, 1, (child) => {
        const version = bytes[child.start] ?? 0;
        if (child.type === "mvhd") {
          const scaleAt = version === 1 ? 20 : 12;
          if (child.start + scaleAt + 4 <= child.end) movieScale = u32be(bytes, child.start + scaleAt);
        } else if (child.type === "trak") {
          readTrak(child.start, child.end);
        } else if (child.type === "mvex") {
          walk(child.start, child.end, 2, (inner) => {
            const innerVersion = bytes[inner.start] ?? 0;
            if (inner.type === "mehd") {
              let ticks = 0;
              if (innerVersion === 1 && inner.start + 12 <= inner.end) ticks = u32be(bytes, inner.start + 4) * 2 ** 32 + u32be(bytes, inner.start + 8);
              else if (inner.start + 8 <= inner.end) ticks = u32be(bytes, inner.start + 4);
              if (!Number.isFinite(ticks) || ticks < 0) failed = true;
              else mehdTicks = ticks;
            } else if (inner.type === "trex" && inner.start + 16 <= inner.end) {
              const trackId = u32be(bytes, inner.start + 4);
              const duration = u32be(bytes, inner.start + 12);
              if (trackId > 0) trexDuration.set(trackId, duration);
            }
          });
        }
      });
    } else if (box.type === "moof") {
      walk(box.start, box.end, 1, (child) => {
        if (child.type !== "traf") return;
        let track = 0;
        let tfhdDuration = 0;
        let tfhdPresent = false;
        let tfdt: number | null = null;
        const pending: Atom[] = [];
        walk(child.start, child.end, 2, (inner) => {
          if (inner.type === "tfhd") {
            const flags = u32be(bytes, inner.start) & 0xffffff;
            if (inner.start + 8 <= inner.end) track = u32be(bytes, inner.start + 4);
            let cursor = inner.start + 8;
            if (flags & 0x000001) cursor += 8;
            if (flags & 0x000002) cursor += 4;
            if ((flags & 0x000008) !== 0 && cursor + 4 <= inner.end) {
              tfhdDuration = u32be(bytes, cursor);
              tfhdPresent = true;
            }
          } else if (inner.type === "tfdt") {
            const version = bytes[inner.start] ?? 0;
            if (version === 1) {
              if (inner.start + 12 > inner.end) {
                failed = true;
                return;
              }
              const wide = u32be(bytes, inner.start + 4) * 2 ** 32 + u32be(bytes, inner.start + 8);
              if (!Number.isFinite(wide) || wide < 0) {
                failed = true;
                return;
              }
              tfdt = wide;
            } else if (inner.start + 8 <= inner.end) {
              tfdt = u32be(bytes, inner.start + 4);
            } else {
              failed = true;
            }
          } else if (inner.type === "trun") {
            pending.push(inner);
          }
        });
        for (const trun of pending) readTrun(trun, track, tfhdPresent, tfhdDuration, tfdt);
      });
    }
  });

  if (failed || moovCount > 1) return null;
  const trackById = new Map<number, Trak>();
  for (const trak of traks) {
    if (trackById.has(trak.id)) return null;
    trackById.set(trak.id, trak);
  }
  const trunTicks = new Map<number, TrunAgg>();
  for (const trun of truns) {
    let ticks = trun.ticks;
    if (trun.needsTrex) {
      const fallback = trexDuration.get(trun.track) ?? 0;
      const next = addFinite(0, trun.samples * fallback);
      if (next === null || (next <= 0 && trun.tfdt === null)) return null;
      ticks = next !== null && next > 0 ? next : 0;
    }
    const agg = trunTicks.get(trun.track) ?? { sum: 0, timeline: 0, timed: false };
    const sum = addFinite(agg.sum, ticks);
    if (sum === null) return null;
    let timeline = agg.timeline;
    let timed = agg.timed;
    if (trun.tfdt !== null) {
      const end = addFinite(trun.tfdt, ticks);
      if (end === null) return null;
      timeline = Math.max(timeline, end);
      timed = true;
    }
    trunTicks.set(trun.track, { sum, timeline, timed });
  }
  let best = 0;
  if (mehdTicks > 0) {
    const ms = ticksToMs(mehdTicks, movieScale);
    if (ms === null || ms <= 0) return null;
    best = ms;
  }
  const trackIds = new Set<number>([...trackById.keys(), ...trunTicks.keys()]);
  for (const id of trackIds) {
    const trak = trackById.get(id);
    const frag = trunTicks.get(id);
    const summed = addFinite(trak?.ticks ?? 0, frag?.sum ?? 0);
    if (summed === null) return null;
    const timeline = frag?.timed ? Math.max(trak?.ticks ?? 0, frag.timeline) : summed;
    const total = Math.max(summed, timeline);
    const scale = trak && trak.scale > 0 ? trak.scale : movieScale;
    let mediaMs = 0;
    if (total > 0) {
      const ms = ticksToMs(total, scale);
      if (ms === null || ms <= 0) return null;
      mediaMs = ms;
    }
    let elstMs = 0;
    if (trak && trak.elstTicks > 0) {
      const ms = ticksToMs(trak.elstTicks, movieScale);
      if (ms === null || ms <= 0) return null;
      elstMs = ms;
    }
    const ms = Math.max(mediaMs, elstMs);
    if (ms <= 0) continue;
    best = Math.max(best, ms);
  }
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

export function imagePixelCount(bytes: Uint8Array): number | null {
  if (PNG(bytes)) return pngPixels(bytes);
  if (JPEG(bytes)) return jpegPixels(bytes);
  if (WEBP(bytes)) return webpPixels(bytes);
  return null;
}

/** Comparison uses the deprecated vision `image` array, so it gets a tighter cap than the omni call. */
export function compareImageBlock(bytes: Uint8Array): string | null {
  if (bytes.length > LIMITS.maxCompareImageBytes) return "Comparison images must be 512 KB or smaller.";
  const pixels = imagePixelCount(bytes);
  if (pixels !== null && pixels > LIMITS.maxCompareImagePixels) return "Comparison images must be 2 megapixels or smaller.";
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
