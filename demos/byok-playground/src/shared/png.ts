export const VISION_COLOURS = ["red", "green", "blue", "black", "white"] as const;
export type VisionColour = (typeof VISION_COLOURS)[number];

export const VISION_RGB: Record<VisionColour, [number, number, number]> = {
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
  black: [0, 0, 0],
  white: [255, 255, 255],
};

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const value of bytes) {
    a = (a + value) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const label = new TextEncoder().encode(type);
  return concat(u32(data.length), label, data, u32(crc32(concat(label, data))));
}

/** Uncompressed 2×1 RGB PNG. */
export function twoPixelPng(left: [number, number, number], right: [number, number, number]): string {
  const ihdr = concat(u32(2), u32(1), new Uint8Array([8, 2, 0, 0, 0]));
  const raw = new Uint8Array([0, left[0], left[1], left[2], right[0], right[1], right[2]]);
  const len = raw.length;
  const nlen = 0xffff ^ len;
  const zlib = concat(
    new Uint8Array([0x78, 0x01, 0x01, len & 255, (len >>> 8) & 255, nlen & 255, (nlen >>> 8) & 255]),
    raw,
    u32(adler32(raw)),
  );
  const png = concat(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib), chunk("IEND", new Uint8Array()));
  let bin = "";
  for (const value of png) bin += String.fromCharCode(value);
  return btoa(bin);
}

export function colourFromRgb(rgb: [number, number, number]): VisionColour | null {
  for (const name of VISION_COLOURS) {
    const [r, g, b] = VISION_RGB[name];
    if (rgb[0] === r && rgb[1] === g && rgb[2] === b) return name;
  }
  return null;
}

/** Read the left pixel of a 2×1 uncompressed RGB PNG produced by `twoPixelPng`. */
export function leftColourFromPngBase64(b64: string): VisionColour | null {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const marker = new TextEncoder().encode("IDAT");
  let idat = -1;
  for (let i = 0; i <= bytes.length - 4; i++) {
    if (bytes[i] === marker[0] && bytes[i + 1] === marker[1] && bytes[i + 2] === marker[2] && bytes[i + 3] === marker[3]) {
      idat = i;
      break;
    }
  }
  if (idat < 0) return null;
  const raw = bytes.subarray(idat + 4 + 2 + 1 + 2 + 2);
  if (raw.length < 4 || raw[0] !== 0) return null;
  return colourFromRgb([raw[1]!, raw[2]!, raw[3]!]);
}

export function pickVisionTarget(): { left: VisionColour; right: VisionColour; png: string } {
  const left = VISION_COLOURS[Math.floor(Math.random() * VISION_COLOURS.length)]!;
  const others = VISION_COLOURS.filter((name) => name !== left);
  const right = others[Math.floor(Math.random() * others.length)]!;
  return { left, right, png: twoPixelPng(VISION_RGB[left], VISION_RGB[right]) };
}
