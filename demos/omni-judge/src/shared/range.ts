export type ParsedRange =
  | { kind: "none" }
  | { kind: "bad" }
  | { kind: "span"; offset: number; length: number }
  | { kind: "suffix"; suffix: number };

export function parseByteRange(header: string | null, size: number): ParsedRange {
  if (header === null || header === "") return { kind: "none" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size < 0) return { kind: "bad" };
  const startRaw = match[1] ?? "";
  const endRaw = match[2] ?? "";
  if (startRaw === "" && endRaw === "") return { kind: "bad" };
  if (startRaw === "") {
    const suffix = Number(endRaw);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return { kind: "bad" };
    return { kind: "suffix", suffix };
  }
  const start = Number(startRaw);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return { kind: "bad" };
  if (endRaw === "") return { kind: "span", offset: start, length: size - start };
  const end = Number(endRaw);
  if (!Number.isSafeInteger(end) || end < start) return { kind: "bad" };
  const last = Math.min(end, size - 1);
  return { kind: "span", offset: start, length: last - start + 1 };
}

export function applyByteRange(
  bytes: Uint8Array,
  header: string | null,
): { status: 200 | 206 | 416; body: Uint8Array; contentRange?: string } {
  const parsed = parseByteRange(header, bytes.length);
  if (parsed.kind === "bad") {
    return { status: 416, body: new Uint8Array(0), contentRange: `bytes */${bytes.length}` };
  }
  if (parsed.kind === "span") {
    return {
      status: 206,
      body: bytes.subarray(parsed.offset, parsed.offset + parsed.length),
      contentRange: `bytes ${parsed.offset}-${parsed.offset + parsed.length - 1}/${bytes.length}`,
    };
  }
  if (parsed.kind === "suffix") {
    const suffixLength = Math.min(parsed.suffix, bytes.length);
    const start = bytes.length - suffixLength;
    return {
      status: 206,
      body: bytes.subarray(start),
      contentRange: `bytes ${start}-${Math.max(start, bytes.length - 1)}/${bytes.length}`,
    };
  }
  return { status: 200, body: bytes };
}
