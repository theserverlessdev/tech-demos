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

function mp4(duration: number, timescale = 1000): Uint8Array {
  const ftyp = atom("ftyp", concat(ascii("isom"), u32le(0).reverse(), ascii("isom")));
  const mvhd = new Uint8Array(100);
  const view = new DataView(mvhd.buffer);
  view.setUint32(12, timescale);
  view.setUint32(16, duration);
  view.setUint32(20, 0x00010000);
  view.setUint16(24, 0x0100);
  view.setUint32(36, 0x00010000);
  view.setUint32(52, 0x00010000);
  view.setUint32(68, 0x40000000);
  view.setUint32(96, 1);
  return concat(ftyp, atom("moov", atom("mvhd", mvhd)), atom("mdat", new Uint8Array(0)));
}

function vint(value: number): Uint8Array {
  return Uint8Array.of(0x80 | value);
}

function element(id: number[], data: Uint8Array): Uint8Array {
  return concat(Uint8Array.from(id), vint(data.length), data);
}

function webm(durationMs: number): Uint8Array {
  const duration = new Uint8Array(8);
  new DataView(duration.buffer).setFloat64(0, durationMs, false);
  const scale = element([0x2a, 0xd7, 0xb1], Uint8Array.of(0x0f, 0x42, 0x40));
  const span = element([0x44, 0x89], duration);
  const info = element([0x15, 0x49, 0xa9, 0x66], concat(scale, span));
  const segment = element([0x18, 0x53, 0x80, 0x67], info);
  const header = element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x86], Uint8Array.of(1)));
  return concat(header, segment);
}

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0));

describe("media caps", () => {
  test("png, jpeg magic and webp pass, gif does not", () => {
    expect(sniffMedia(PNG)).toMatchObject({ ok: true, kind: "image", contentType: "image/png" });
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
    expect(sniffMedia(jpeg)).toMatchObject({ ok: true, contentType: "image/jpeg" });
    const webp = concat(ascii("RIFF"), u32le(12), ascii("WEBP"), ascii("VP8 "));
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
    const long = sniffMedia(mp4(11_000));
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.message).toContain("10 seconds");
    const clip = sniffMedia(webm(1000));
    expect(clip).toMatchObject({ ok: true, contentType: "video/webm" });
    if (clip.ok) expect(clip.durationMs).toBe(1000);
    const over = sniffMedia(webm(11_000));
    expect(over.ok).toBe(false);
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
