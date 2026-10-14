import { HttpError } from "./errors";

export function rejectOversizedContentLength(headers: Headers, maxBytes: number, message: string): void {
  const raw = headers.get("content-length");
  if (!raw) return;
  const n = Number(raw);
  if (Number.isFinite(n) && n > maxBytes) throw new HttpError(413, "too_large", message);
}

/** Byte-counting reader. Cancels the source as soon as the cap is crossed. */
export async function readCappedBytes(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
  error: HttpError = new HttpError(413, "too_large", "The request body is too large."),
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      if (seen > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw error;
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err !== error) await reader.cancel().catch(() => undefined);
    throw err;
  }
  const out = new Uint8Array(seen);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
