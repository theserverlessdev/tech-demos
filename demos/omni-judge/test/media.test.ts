import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { LIMITS } from "../src/shared/limits";
import { sniffMedia } from "../src/shared/media";

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u32le(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function u16le(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (char) => char.charCodeAt(0));
}

function wav(seconds: number, rate = 8_000): Uint8Array {
  const dataBytes = Math.round(seconds * rate);
  const data = new Uint8Array(dataBytes);
  const fmt = concat(u16le(1), u16le(1), u32le(rate), u32le(rate), u16le(1), u16le(8));
  const body = concat(ascii("fmt "), u32le(fmt.length), fmt, ascii("data"), u32le(dataBytes), data);
  return concat(ascii("RIFF"), u32le(4 + body.length), ascii("WAVE"), body);
}

function atom(type: string, payload: Uint8Array): Uint8Array {
  const head = new Uint8Array(8);
  new DataView(head.buffer).setUint32(0, 8 + payload.length);
  head.set(ascii(type), 4);
  return concat(head, payload);
}

function u32be(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function mp4(duration: number, timescale = 1000): Uint8Array {
  const ftyp = atom("ftyp", concat(ascii("isom"), u32le(0).reverse(), ascii("isom")));
  const mvhd = new Uint8Array(100);
  const view = new DataView(mvhd.buffer);
  view.setUint32(12, timescale);
  view.setUint32(16, 0);
  view.setUint32(20, 0x00010000);
  view.setUint16(24, 0x0100);
  view.setUint32(36, 0x00010000);
  view.setUint32(52, 0x00010000);
  view.setUint32(68, 0x40000000);
  view.setUint32(96, 1);
  const tkhd = new Uint8Array(84);
  new DataView(tkhd.buffer).setUint32(12, 1);
  const mdhd = new Uint8Array(24);
  new DataView(mdhd.buffer).setUint32(12, timescale);
  const stts = concat(u32be(0), u32be(1), u32be(1), u32be(duration));
  const trak = atom("trak", concat(atom("tkhd", tkhd), atom("mdia", concat(atom("mdhd", mdhd), atom("minf", atom("stbl", atom("stts", stts)))))));
  return concat(ftyp, atom("moov", concat(atom("mvhd", mvhd), trak)), atom("mdat", new Uint8Array(0)));
}

/** Safari MediaRecorder shape: mvhd duration 0, optional mehd, trun sample durations. */
function safariFmp4(options: { mehd?: number; samples?: number; sampleDuration?: number; timescale?: number }): Uint8Array {
  const timescale = options.timescale ?? 1000;
  const ftyp = atom("ftyp", concat(ascii("isom"), u32be(0), ascii("iso5")));
  const mvhd = new Uint8Array(100);
  new DataView(mvhd.buffer).setUint32(12, timescale);
  const tkhd = new Uint8Array(84);
  new DataView(tkhd.buffer).setUint32(12, 1);
  const mdhd = new Uint8Array(24);
  new DataView(mdhd.buffer).setUint32(12, timescale);
  const trak = atom("trak", concat(atom("tkhd", tkhd), atom("mdia", atom("mdhd", mdhd))));
  const mehd = options.mehd === undefined ? new Uint8Array(0) : atom("mehd", concat(u32be(0), u32be(options.mehd)));
  const mvex = mehd.length ? atom("mvex", mehd) : new Uint8Array(0);
  const moov = atom("moov", concat(atom("mvhd", mvhd), trak, mvex));
  let moof = new Uint8Array(0);
  if (options.samples && options.sampleDuration) {
    const flags = 0x000008;
    const tfhd = concat(u32be(flags), u32be(1), u32be(options.sampleDuration));
    const trun = concat(u32be(0), u32be(options.samples));
    const traf = atom("traf", concat(atom("tfhd", tfhd), atom("trun", trun)));
    moof = atom("moof", concat(atom("mfhd", concat(u32be(0), u32be(1))), traf));
  }
  return concat(ftyp, moov, moof, atom("mdat", new Uint8Array(0)));
}

function mp3Frame(): Uint8Array {
  const frame = new Uint8Array(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  return frame;
}

function vint(value: number): Uint8Array {
  return Uint8Array.of(0x80 | value);
}

function element(id: number[], data: Uint8Array): Uint8Array {
  return concat(Uint8Array.from(id), vint(data.length), data);
}

function ebmlUnknown(): Uint8Array {
  return Uint8Array.of(0xff);
}

function simpleBlock(relMs: number): Uint8Array {
  const body = new Uint8Array(4);
  body[0] = 0x81;
  new DataView(body.buffer).setInt16(1, relMs, false);
  body[3] = 0x80;
  return element([0xa3], body);
}

/** Chrome MediaRecorder shape: unknown-size segment and clusters, timecode at cluster depth. */
function chromeWebm(clusters: { tc: number; rel: number[] }[], liedDurationMs?: number): Uint8Array {
  const scale = element([0x2a, 0xd7, 0xb1], Uint8Array.of(0x0f, 0x42, 0x40));
  const lied = new Uint8Array(8);
  new DataView(lied.buffer).setFloat64(0, liedDurationMs ?? 1, false);
  const info = element([0x15, 0x49, 0xa9, 0x66], concat(scale, element([0x44, 0x89], lied)));
  const clusterBytes = clusters.map((cluster) => {
    const tc = new Uint8Array(2);
    new DataView(tc.buffer).setUint16(0, cluster.tc, false);
    const blocks = cluster.rel.map((rel) => simpleBlock(rel));
    return concat(Uint8Array.of(0x1f, 0x43, 0xb6, 0x75), ebmlUnknown(), element([0xe7], tc), ...blocks);
  });
  const header = element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x86], Uint8Array.of(1)));
  return concat(header, Uint8Array.of(0x18, 0x53, 0x80, 0x67), ebmlUnknown(), info, ...clusterBytes);
}

function webm(durationMs: number): Uint8Array {
  return chromeWebm([{ tc: 0, rel: [durationMs] }], 60_000);
}

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0));

describe("media caps", () => {
  test("png, jpeg magic and webp pass, gif does not", () => {
    expect(sniffMedia(PNG)).toMatchObject({ ok: true, kind: "image", contentType: "image/png" });
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9);
    expect(sniffMedia(jpeg)).toMatchObject({ ok: true, contentType: "image/jpeg" });
    const vp8 = concat(Uint8Array.of(0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a), u16le(1), u16le(1));
    const webp = concat(ascii("RIFF"), u32le(4 + 8 + vp8.length), ascii("WEBP"), ascii("VP8 "), u32le(vp8.length), vp8);
    expect(sniffMedia(webp)).toMatchObject({ ok: true, contentType: "image/webp" });
    expect(sniffMedia(ascii("GIF89a")).ok).toBe(false);
  });

  test("an image over 2 MB is rejected from the byte length", () => {
    const big = new Uint8Array(LIMITS.maxImageBytes + 1);
    big.set(PNG);
    const sniffed = sniffMedia(big);
    expect(sniffed.ok).toBe(false);
    if (!sniffed.ok) expect(sniffed.message).toContain("2 MB");
  });

  test("wav duration is read from the data chunk", () => {
    const ok = sniffMedia(wav(1));
    expect(ok).toMatchObject({ ok: true, kind: "audio", contentType: "audio/wav" });
    if (ok.ok) expect(ok.durationMs).toBe(1000);
    const long = sniffMedia(wav(16));
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.message).toContain("15 seconds");
  });

  test("audio over 1.5 MB is rejected even when the duration is short", () => {
    const padded = new Uint8Array(LIMITS.maxAudioBytes + 1);
    padded.set(wav(1));
    const sniffed = sniffMedia(padded);
    expect(sniffed.ok).toBe(false);
    if (!sniffed.ok) expect(sniffed.message).toContain("1.5 MB");
  });

  test("mp4 and webm durations are capped at 10 seconds", () => {
    const short = sniffMedia(mp4(1000));
    expect(short).toMatchObject({ ok: true, kind: "video", contentType: "video/mp4" });
    if (short.ok) expect(short.durationMs).toBe(1000);
    const slack = sniffMedia(mp4(10_400));
    expect(slack.ok).toBe(true);
    const long = sniffMedia(mp4(10_600));
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.message).toContain("10 seconds");
    const clip = sniffMedia(webm(1000));
    expect(clip).toMatchObject({ ok: true, contentType: "video/webm" });
    if (clip.ok) expect(clip.durationMs).toBe(1000);
    const over = sniffMedia(webm(11_000));
    expect(over.ok).toBe(false);
  });

  test("images over 16 megapixels are rejected from the header", () => {
    const png = new Uint8Array(PNG);
    const view = new DataView(png.buffer);
    view.setUint32(16, 5000);
    view.setUint32(20, 5000);
    const sniffed = sniffMedia(png);
    expect(sniffed.ok).toBe(false);
    if (!sniffed.ok) expect(sniffed.message).toContain("16 megapixels");
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x13, 0x88, 0x13, 0x88, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9);
    const wide = sniffMedia(jpeg);
    expect(wide.ok).toBe(false);
  });

  test("a Chrome MediaRecorder webm uses block timecodes, not the Duration header", () => {
    const clip = sniffMedia(chromeWebm([{ tc: 0, rel: [0, 400] }, { tc: 800, rel: [200] }], 60_000));
    expect(clip).toMatchObject({ ok: true, contentType: "video/webm" });
    if (clip.ok) expect(clip.durationMs).toBe(1000);
    const hidden = sniffMedia(chromeWebm([{ tc: 0, rel: [12_000] }], 1));
    expect(hidden.ok).toBe(false);
    if (!hidden.ok) expect(hidden.message).toContain("10 seconds");
  });

  test("a Safari fMP4 ignores a zero mvhd and reads mehd or trun", () => {
    const fromMehd = sniffMedia(safariFmp4({ mehd: 1500 }));
    expect(fromMehd).toMatchObject({ ok: true, contentType: "video/mp4" });
    if (fromMehd.ok) expect(fromMehd.durationMs).toBe(1500);
    const fromTrun = sniffMedia(safariFmp4({ samples: 10, sampleDuration: 100 }));
    expect(fromTrun).toMatchObject({ ok: true, kind: "video" });
    if (fromTrun.ok) expect(fromTrun.durationMs).toBe(1000);
    const lyingHeader = sniffMedia(safariFmp4({ mehd: 100, samples: 12, sampleDuration: 1000 }));
    expect(lyingHeader.ok).toBe(false);
  });

  test("mp3 duration walks frames and ignores a short Xing header", () => {
    const frame = mp3Frame();
    const head = new Uint8Array(frame);
    const xingAt = 36;
    head.set(ascii("Xing"), xingAt);
    new DataView(head.buffer).setUint32(xingAt + 4, 1);
    new DataView(head.buffer).setUint32(xingAt + 8, 1);
    const many = concat(head, frame, frame, frame, frame, frame, frame, frame, frame, frame);
    const sniffed = sniffMedia(many);
    expect(sniffed.ok).toBe(true);
    if (sniffed.ok) expect(sniffed.durationMs).toBeGreaterThan(200);
    const padded = concat(many, new Uint8Array(80_000));
    const withJunk = sniffMedia(padded);
    expect(withJunk.ok).toBe(true);
    if (sniffed.ok && withJunk.ok) expect(withJunk.durationMs).toBe(sniffed.durationMs);
  });

  test("a real ffmpeg clip and mp3 stay inside the caps", () => {
    const mp3 = new Uint8Array(readFileSync(new URL("./fixtures/one.mp3", import.meta.url)));
    const mp3Sniff = sniffMedia(mp3);
    expect(mp3Sniff.ok).toBe(true);
    if (mp3Sniff.ok) expect(mp3Sniff.durationMs).toBeGreaterThan(500);
    if (mp3Sniff.ok) expect(mp3Sniff.durationMs).toBeLessThan(2_000);
    const webmFile = new Uint8Array(readFileSync(new URL("./fixtures/one.webm", import.meta.url)));
    const webmSniff = sniffMedia(webmFile);
    expect(webmSniff).toMatchObject({ ok: true, contentType: "video/webm" });
    if (webmSniff.ok) expect(webmSniff.durationMs).toBeGreaterThan(500);
    if (webmSniff.ok) expect(webmSniff.durationMs).toBeLessThan(2_000);
  });
});
