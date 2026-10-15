const CHECKS: Record<string, (bytes: Uint8Array) => boolean> = {
  "image/jpeg": (bytes) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/png": (bytes) => bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
  "image/gif": (bytes) => bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38,
  "image/webp": (bytes) =>
    bytes.length > 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50,
};

/** Content-Type is caller-controlled. The bytes have to match too. */
export function sniffImage(bytes: Uint8Array, declared: string): string | null {
  const type = declared.toLowerCase().split(";")[0]?.trim() ?? "";
  const check = CHECKS[type];
  if (!check || !check(bytes)) return null;
  return type;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Drop APP1 (EXIF / XMP) so GPS and camera tags do not land on the public board. */
export function stripJpegExif(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let i = 2;
  let changed = false;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) {
      parts.push(bytes.subarray(i));
      break;
    }
    const marker = bytes[i + 1];
    if (marker === 0xda || marker === 0xd9) {
      parts.push(bytes.subarray(i));
      break;
    }
    if (marker === 0x00 || marker === 0xff || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(bytes.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 3 >= bytes.length) {
      parts.push(bytes.subarray(i));
      break;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2 || i + 2 + len > bytes.length) {
      parts.push(bytes.subarray(i));
      break;
    }
    if (marker === 0xe1) changed = true;
    else parts.push(bytes.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return changed ? concat(parts) : bytes;
}
