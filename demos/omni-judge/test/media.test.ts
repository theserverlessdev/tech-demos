import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { LIMITS } from "../src/shared/limits";
import { compareImageBlock, sniffMedia } from "../src/shared/media";

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

function u16be(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, false);
  return bytes;
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
  return chromeWebm([{ tc: 0, rel: [0, durationMs] }], 60_000);
}

function unknown8(): Uint8Array {
  return Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
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
    const hidden = sniffMedia(chromeWebm([{ tc: 0, rel: [0, 12_000] }], 1));
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

  test("a nested size-zero trak finishes inside the time budget", () => {
    const ftyp = atom("ftyp", concat(ascii("isom"), u32be(0), ascii("isom")));
    const unit = concat(u32be(16), ascii("moov"), u32be(0), ascii("trak"));
    const repeats = Math.ceil(6400 / unit.length);
    const bomb = new Uint8Array(repeats * unit.length);
    for (let i = 0; i < repeats; i++) bomb.set(unit, i * unit.length);
    const file = concat(ftyp, bomb);
    expect(file.length).toBeGreaterThanOrEqual(6400);
    const started = performance.now();
    const sniffed = sniffMedia(file);
    expect(performance.now() - started).toBeLessThan(200);
    expect(sniffed.ok).toBe(false);
  });

  test("a Chrome timeslice WebM uses an 8-byte unknown size and ignores a decoy scale", () => {
    const decoy = element([0x2a, 0xd7, 0xb1], Uint8Array.of(0x01));
    const header = element([0x1a, 0x45, 0xdf, 0xa3], concat(element([0x42, 0x86], Uint8Array.of(1)), decoy));
    const scale = element([0x2a, 0xd7, 0xb1], Uint8Array.of(0x0f, 0x42, 0x40));
    const info = element([0x15, 0x49, 0xa9, 0x66], scale);
    const tc = new Uint8Array(2);
    new DataView(tc.buffer).setUint16(0, 0, false);
    const cluster = concat(Uint8Array.of(0x1f, 0x43, 0xb6, 0x75), unknown8(), element([0xe7], tc), simpleBlock(0), simpleBlock(1000));
    const file = concat(header, Uint8Array.of(0x18, 0x53, 0x80, 0x67), unknown8(), info, cluster);
    const sniffed = sniffMedia(file);
    expect(sniffed).toMatchObject({ ok: true, contentType: "video/webm" });
    if (sniffed.ok) expect(sniffed.durationMs).toBe(1000);
    const onePoint = sniffMedia(chromeWebm([{ tc: 0, rel: [1000] }], 60_000));
    expect(onePoint.ok).toBe(false);
    if (!onePoint.ok) expect(onePoint.message).toContain("no readable duration");
  });

  test("a Chrome fMP4 reads trex when tfhd and trun omit sample duration", () => {
    const ftyp = atom("ftyp", concat(ascii("iso5"), u32be(0), ascii("iso5")));
    const mvhd = new Uint8Array(100);
    new DataView(mvhd.buffer).setUint32(12, 1000);
    const mdhd = new Uint8Array(24);
    new DataView(mdhd.buffer).setUint32(12, 1000);
    const tkhd = new Uint8Array(84);
    new DataView(tkhd.buffer).setUint32(12, 1);
    const trak = atom("trak", concat(atom("mdia", atom("mdhd", mdhd)), atom("tkhd", tkhd)));
    const trex = concat(u32be(0), u32be(1), u32be(1), u32be(100), u32be(0), u32be(0));
    const moov = atom("moov", concat(atom("mvhd", mvhd), trak, atom("mvex", atom("trex", trex))));
    const tfhd = concat(u32be(0), u32be(1));
    const trun = concat(u32be(0), u32be(10));
    const traf = atom("traf", concat(atom("trun", trun), atom("tfhd", tfhd)));
    const moof = concat(u32be(1), ascii("moof"), new Uint8Array(8).fill(0xff), traf);
    const sniffed = sniffMedia(concat(ftyp, moov, moof));
    expect(sniffed).toMatchObject({ ok: true, contentType: "video/mp4" });
    if (sniffed.ok) expect(sniffed.durationMs).toBe(1000);
  });

  test("a second moov, a duplicate track id, or samples without duration are rejected", () => {
    expect(sniffMedia(concat(mp4(1000), mp4(1000))).ok).toBe(false);
    const ftyp = atom("ftyp", concat(ascii("isom"), u32be(0), ascii("isom")));
    const mvhd = new Uint8Array(100);
    new DataView(mvhd.buffer).setUint32(12, 1000);
    const trak = (id: number, delta: number) => {
      const tkhd = new Uint8Array(84);
      new DataView(tkhd.buffer).setUint32(12, id);
      const mdhd = new Uint8Array(24);
      new DataView(mdhd.buffer).setUint32(12, 1000);
      const stts = concat(u32be(0), u32be(1), u32be(1), u32be(delta));
      return atom("trak", concat(atom("tkhd", tkhd), atom("mdia", concat(atom("mdhd", mdhd), atom("minf", atom("stbl", atom("stts", stts)))))));
    };
    expect(sniffMedia(concat(ftyp, atom("moov", concat(atom("mvhd", mvhd), trak(1, 1000), trak(1, 500))))).ok).toBe(false);
    expect(sniffMedia(concat(ftyp, atom("moov", concat(atom("mvhd", mvhd), trak(1, 0))))).ok).toBe(false);
  });

  test("a high-bit timescale stays unsigned", () => {
    const ftyp = atom("ftyp", concat(ascii("isom"), u32be(0), ascii("isom")));
    const mvhd = new Uint8Array(100);
    new DataView(mvhd.buffer).setUint32(12, 0x80000000);
    const tkhd = new Uint8Array(84);
    new DataView(tkhd.buffer).setUint32(12, 1);
    const mdhd = new Uint8Array(24);
    new DataView(mdhd.buffer).setUint32(12, 0x80000000);
    const stts = concat(u32be(0), u32be(1), u32be(1), u32be(0x80000000));
    const trak = atom("trak", concat(atom("mdhd", mdhd), atom("tkhd", tkhd), atom("mdia", atom("minf", atom("stbl", atom("stts", stts))))));
    const sniffed = sniffMedia(concat(ftyp, atom("moov", concat(atom("mvhd", mvhd), trak))));
    expect(sniffed).toMatchObject({ ok: true, kind: "video" });
    if (sniffed.ok) expect(sniffed.durationMs).toBe(1000);
  });

  test("mp3 keeps counting after junk and sums mixed sample rates", () => {
    const mpeg1 = mp3Frame();
    const mpeg48 = new Uint8Array(384);
    mpeg48[0] = 0xff;
    mpeg48[1] = 0xfb;
    mpeg48[2] = 0x94;
    const junk = new Uint8Array(64);
    const file = concat(mpeg1, mpeg1, junk, mpeg48, mpeg48);
    const sniffed = sniffMedia(file);
    expect(sniffed.ok).toBe(true);
    if (sniffed.ok) {
      const expected = Math.ceil((2 * 1152 * 1000) / 44100 + (2 * 1152 * 1000) / 48000);
      expect(sniffed.durationMs).toBe(expected);
    }
  });

  test("fragmented mp4 sums every trun on a track and adds stts", () => {
    const moof = (sequence: number, samples: number, sampleDuration: number) => {
      const tfhd = concat(u32be(0x000008), u32be(1), u32be(sampleDuration));
      const trun = concat(u32be(0), u32be(samples));
      const traf = atom("traf", concat(atom("tfhd", tfhd), atom("trun", trun)));
      return atom("moof", concat(atom("mfhd", concat(u32be(0), u32be(sequence))), traf));
    };
    const pieces = [safariFmp4({})];
    for (let i = 0; i < 4; i++) pieces.push(moof(i + 1, 1, 500));
    const summed = sniffMedia(concat(...pieces));
    expect(summed).toMatchObject({ ok: true, contentType: "video/mp4" });
    if (summed.ok) expect(summed.durationMs).toBe(2000);

    const ftyp = atom("ftyp", concat(ascii("isom"), u32be(0), ascii("iso5")));
    const mvhd = new Uint8Array(100);
    new DataView(mvhd.buffer).setUint32(12, 1000);
    const tkhd = new Uint8Array(84);
    new DataView(tkhd.buffer).setUint32(12, 1);
    const mdhd = new Uint8Array(24);
    new DataView(mdhd.buffer).setUint32(12, 1000);
    const stts = concat(u32be(0), u32be(1), u32be(1), u32be(1000));
    const trak = atom("trak", concat(atom("tkhd", tkhd), atom("mdia", concat(atom("mdhd", mdhd), atom("minf", atom("stbl", atom("stts", stts)))))));
    const moov = atom("moov", concat(atom("mvhd", mvhd), trak));
    const withTable = sniffMedia(concat(ftyp, moov, moof(1, 1, 1000), moof(2, 1, 1000)));
    expect(withTable).toMatchObject({ ok: true, kind: "video" });
    if (withTable.ok) expect(withTable.durationMs).toBe(3000);
  });

  test("a Chrome-style fragmented mp4 keeps 9.5 seconds and rejects 50", () => {
    const short = new Uint8Array(readFileSync(new URL("./fixtures/frag-9s5.mp4", import.meta.url)));
    const sniffed = sniffMedia(short);
    expect(sniffed).toMatchObject({ ok: true, contentType: "video/mp4" });
    if (sniffed.ok) expect(Math.abs(sniffed.durationMs! - 9500)).toBeLessThanOrEqual(100);
    const long = new Uint8Array(readFileSync(new URL("./fixtures/frag-50s.mp4", import.meta.url)));
    const rejected = sniffMedia(long);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.message).toContain("10 seconds");
  });

  test("mp3 past 15 seconds is rejected even when rounding would land on the cap", () => {
    const frames = Array.from({ length: 700 }, () => mp3Frame());
    const sniffed = sniffMedia(concat(...frames));
    expect(sniffed.ok).toBe(false);
    if (!sniffed.ok) expect(sniffed.message).toContain("15 seconds");
  });

  test("wav keeps the first fmt and requires it before the data", () => {
    const fmt = (rate: number) => concat(u16le(1), u16le(1), u32le(rate), u32le(rate), u16le(1), u16le(8));
    const data = new Uint8Array(8000);
    const body = concat(ascii("fmt "), u32le(16), fmt(8000), ascii("fmt "), u32le(16), fmt(48000), ascii("data"), u32le(data.length), data);
    const sniffed = sniffMedia(concat(ascii("RIFF"), u32le(4 + body.length), ascii("WAVE"), body));
    expect(sniffed).toMatchObject({ ok: true, kind: "audio" });
    if (sniffed.ok) expect(sniffed.durationMs).toBe(1000);
    const late = concat(ascii("data"), u32le(data.length), data, ascii("fmt "), u32le(16), fmt(8000));
    const missing = sniffMedia(concat(ascii("RIFF"), u32le(4 + late.length), ascii("WAVE"), late));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toContain("PCM WAV");
  });

  test("an unknown-size webm cluster ignores a Cluster id inside a Void", () => {
    const scale = element([0x2a, 0xd7, 0xb1], Uint8Array.of(0x0f, 0x42, 0x40));
    const info = element([0x15, 0x49, 0xa9, 0x66], scale);
    const header = element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x86], Uint8Array.of(1)));
    const tc = new Uint8Array(2);
    const decoy = concat(Uint8Array.of(0x1f, 0x43, 0xb6, 0x75), simpleBlock(5000));
    const hole = element([0xec], decoy);
    const cluster = concat(Uint8Array.of(0x1f, 0x43, 0xb6, 0x75), ebmlUnknown(), element([0xe7], tc), hole, simpleBlock(0), simpleBlock(1000));
    const sniffed = sniffMedia(concat(header, Uint8Array.of(0x18, 0x53, 0x80, 0x67), ebmlUnknown(), info, cluster));
    expect(sniffed).toMatchObject({ ok: true, contentType: "video/webm" });
    if (sniffed.ok) expect(sniffed.durationMs).toBe(1000);

    const overrun = concat(Uint8Array.of(0xa3), Uint8Array.of(0x80 | 80), new Uint8Array(4));
    const broken = concat(header, Uint8Array.of(0x18, 0x53, 0x80, 0x67), ebmlUnknown(), info, Uint8Array.of(0x1f, 0x43, 0xb6, 0x75), ebmlUnknown(), element([0xe7], tc), overrun);
    const rejected = sniffMedia(broken);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.message).toContain("no readable duration");
  });

  test("an stts or trun count that does not fit is rejected", () => {
    const ftyp = atom("ftyp", concat(ascii("isom"), u32be(0), ascii("isom")));
    const mvhd = new Uint8Array(100);
    new DataView(mvhd.buffer).setUint32(12, 1000);
    const trakFor = (stbl: Uint8Array) => {
      const tkhd = new Uint8Array(84);
      new DataView(tkhd.buffer).setUint32(12, 1);
      const mdhd = new Uint8Array(24);
      new DataView(mdhd.buffer).setUint32(12, 1000);
      return atom("trak", concat(atom("tkhd", tkhd), atom("mdia", concat(atom("mdhd", mdhd), atom("minf", atom("stbl", stbl))))));
    };
    const shortTable = concat(u32be(0), u32be(5), u32be(1), u32be(1000));
    const sttsFile = sniffMedia(concat(ftyp, atom("moov", concat(atom("mvhd", mvhd), trakFor(atom("stts", shortTable))))));
    expect(sttsFile.ok).toBe(false);
    if (!sttsFile.ok) expect(sttsFile.message).toContain("no readable duration");

    const disagree = concat(atom("stts", concat(u32be(0), u32be(1), u32be(1), u32be(1000))), atom("stsz", concat(u32be(0), u32be(1), u32be(2))));
    expect(sniffMedia(concat(ftyp, atom("moov", concat(atom("mvhd", mvhd), trakFor(disagree))))).ok).toBe(false);

    const tfhd = concat(u32be(0x000008), u32be(1), u32be(500));
    const shortTrun = concat(u32be(0x100), u32be(3), u32be(500));
    const hugeTrun = concat(u32be(0), u32be(200_001));
    const base = safariFmp4({});
    const truncated = sniffMedia(concat(base, atom("moof", atom("traf", concat(atom("tfhd", tfhd), atom("trun", shortTrun))))));
    expect(truncated.ok).toBe(false);
    if (!truncated.ok) expect(truncated.message).toContain("no readable duration");
    const capped = sniffMedia(concat(base, atom("moof", atom("traf", concat(atom("tfhd", tfhd), atom("trun", hugeTrun))))));
    expect(capped.ok).toBe(false);
  });

  test("wav duration sums every data chunk", () => {
    const fmt = concat(u16le(1), u16le(1), u32le(8000), u32le(8000), u16le(1), u16le(8));
    const chunk = (seconds: number) => {
      const data = new Uint8Array(Math.round(seconds * 8000));
      return concat(ascii("data"), u32le(data.length), data);
    };
    const body = concat(ascii("fmt "), u32le(fmt.length), fmt, chunk(0.5), chunk(0.5));
    const both = concat(ascii("RIFF"), u32le(4 + body.length), ascii("WAVE"), body);
    const sniffed = sniffMedia(both);
    expect(sniffed).toMatchObject({ ok: true, kind: "audio" });
    if (sniffed.ok) expect(sniffed.durationMs).toBe(1000);
    const longBody = concat(ascii("fmt "), u32le(fmt.length), fmt, chunk(1), chunk(16));
    const long = sniffMedia(concat(ascii("RIFF"), u32le(4 + longBody.length), ascii("WAVE"), longBody));
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.message).toContain("15 seconds");
  });

  test("a junk byte, an unknown-size void, or a second info does not shorten webm", () => {
    const scale = element([0x2a, 0xd7, 0xb1], Uint8Array.of(0x0f, 0x42, 0x40));
    const info = element([0x15, 0x49, 0xa9, 0x66], scale);
    const header = element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x86], Uint8Array.of(1)));
    const cluster = (tc: number, rel: number[]) => {
      const time = new Uint8Array(3);
      time[0] = (tc >> 16) & 0xff;
      time[1] = (tc >> 8) & 0xff;
      time[2] = tc & 0xff;
      return element([0x1f, 0x43, 0xb6, 0x75], concat(element([0xe7], time), ...rel.map((value) => simpleBlock(value))));
    };
    const early = cluster(0, [0, 5000]);
    const late = cluster(50_000, [0]);
    const wrap = (...parts: Uint8Array[]) => concat(header, Uint8Array.of(0x18, 0x53, 0x80, 0x67), ebmlUnknown(), info, ...parts);
    const rejected = (file: Uint8Array) => {
      const sniffed = sniffMedia(file);
      expect(sniffed.ok).toBe(false);
      if (!sniffed.ok) expect(sniffed.message).toContain("no readable duration");
    };
    rejected(wrap(early, Uint8Array.of(0x00), late));
    rejected(wrap(early, concat(Uint8Array.of(0xec), unknown8()), late));
    rejected(wrap(early, concat(Uint8Array.of(0x15, 0x49, 0xa9, 0x66), unknown8()), late));
    const small = element([0x2a, 0xd7, 0xb1], Uint8Array.of(0x01, 0x86, 0xa0));
    const second = element([0x15, 0x49, 0xa9, 0x66], small);
    rejected(wrap(early, late, second));
    rejected(wrap(early, second, late));
    const padded = sniffMedia(concat(wrap(cluster(0, [0, 1000])), new Uint8Array(16)));
    expect(padded).toMatchObject({ ok: true, contentType: "video/webm" });
    if (padded.ok) expect(padded.durationMs).toBe(1000);
  });

  test("a chrome timeslice webm keeps trailing zeros and a cut tail", () => {
    const zeros = sniffMedia(concat(chromeWebm([{ tc: 0, rel: [0, 1000] }]), new Uint8Array(32)));
    expect(zeros).toMatchObject({ ok: true, contentType: "video/webm" });
    if (zeros.ok) expect(zeros.durationMs).toBe(1000);
    const full = chromeWebm([{ tc: 0, rel: [0, 4000, 8000] }]);
    const cut = sniffMedia(full.subarray(0, full.length - 3));
    expect(cut).toMatchObject({ ok: true, contentType: "video/webm" });
    if (cut.ok) expect(cut.durationMs).toBe(4000);
  });

  test("an edit list can repeat a short track out past the cap", () => {
    const ftyp = atom("ftyp", concat(ascii("isom"), u32be(0), ascii("isom")));
    const mvhd = new Uint8Array(100);
    new DataView(mvhd.buffer).setUint32(12, 1000);
    const tkhd = new Uint8Array(84);
    new DataView(tkhd.buffer).setUint32(12, 1);
    const mdhd = new Uint8Array(24);
    new DataView(mdhd.buffer).setUint32(12, 1000);
    const stts = concat(u32be(0), u32be(1), u32be(1), u32be(5000));
    const entry = (duration: number) => concat(u32be(duration), u32be(0), u16be(1), u16be(0));
    const entries = Array.from({ length: 10 }, () => entry(5000));
    const elst = concat(u32be(0), u32be(10), ...entries);
    const trak = atom(
      "trak",
      concat(atom("tkhd", tkhd), atom("edts", atom("elst", elst)), atom("mdia", concat(atom("mdhd", mdhd), atom("minf", atom("stbl", atom("stts", stts)))))),
    );
    const repeated = sniffMedia(concat(ftyp, atom("moov", concat(atom("mvhd", mvhd), trak))));
    expect(repeated.ok).toBe(false);
    if (!repeated.ok) expect(repeated.message).toContain("10 seconds");
    const once = concat(u32be(0), u32be(1), entry(5000));
    const matching = atom(
      "trak",
      concat(atom("tkhd", tkhd), atom("edts", atom("elst", once)), atom("mdia", concat(atom("mdhd", mdhd), atom("minf", atom("stbl", atom("stts", stts)))))),
    );
    const kept = sniffMedia(concat(ftyp, atom("moov", concat(atom("mvhd", mvhd), matching))));
    expect(kept).toMatchObject({ ok: true, kind: "video" });
    if (kept.ok) expect(kept.durationMs).toBe(5000);
  });

  test("tfdt jumps place 1-tick fragments on a long timeline", () => {
    const pieces = [safariFmp4({})];
    for (let i = 0; i < 50; i++) {
      const tfhd = concat(u32be(0x000008), u32be(1), u32be(1));
      const tfdt = concat(u32be(0), u32be(i * 1000));
      const trun = concat(u32be(0), u32be(1));
      const traf = atom("traf", concat(atom("tfhd", tfhd), atom("tfdt", tfdt), atom("trun", trun)));
      pieces.push(atom("moof", traf));
    }
    const jumped = sniffMedia(concat(...pieces));
    expect(jumped.ok).toBe(false);
    if (!jumped.ok) expect(jumped.message).toContain("10 seconds");
    const short = [safariFmp4({})];
    for (let i = 0; i < 3; i++) {
      const tfhd = concat(u32be(0x000008), u32be(1), u32be(1));
      const tfdt = concat(u32be(0), u32be(i * 1000));
      const trun = concat(u32be(0), u32be(1));
      short.push(atom("moof", atom("traf", concat(atom("tfhd", tfhd), atom("tfdt", tfdt), atom("trun", trun)))));
    }
    const placed = sniffMedia(concat(...short));
    expect(placed).toMatchObject({ ok: true, kind: "video" });
    if (placed.ok) expect(placed.durationMs).toBe(2001);
  });

  test("a stock ffmpeg frag_every_frame file stays inside the cap", () => {
    const file = new Uint8Array(readFileSync(new URL("./fixtures/frag-every-frame.mp4", import.meta.url)));
    const sniffed = sniffMedia(file);
    expect(sniffed).toMatchObject({ ok: true, contentType: "video/mp4" });
    if (sniffed.ok) expect(Math.abs((sniffed.durationMs ?? 0) - 2000)).toBeLessThanOrEqual(200);
  });

  test("an exact mp3 duration does not gain a millisecond", () => {
    const frames = Array.from({ length: 196 }, () => mp3Frame());
    const sniffed = sniffMedia(concat(...frames));
    expect(sniffed).toMatchObject({ ok: true, kind: "audio" });
    if (sniffed.ok) expect(sniffed.durationMs).toBe(5120);
  });

  test("comparison images stop at 512 KB or 2 megapixels", () => {
    expect(compareImageBlock(PNG)).toBeNull();
    const wide = new Uint8Array(PNG);
    const view = new DataView(wide.buffer);
    view.setUint32(16, 2000);
    view.setUint32(20, 1001);
    expect(compareImageBlock(wide)).toContain("2 megapixels");
    const padded = new Uint8Array(LIMITS.maxCompareImageBytes + 1);
    padded.set(PNG);
    expect(compareImageBlock(padded)).toContain("512 KB");
  });
});
