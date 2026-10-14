import { HttpError } from "./errors";

export function rejectOversizedContentLength(
  headers: Headers,
  maxBytes: number,
  message: string,
  status = 413,
): void {
  const raw = headers.get("content-length");
  if (!raw) return;
  const n = Number(raw);
  if (Number.isFinite(n) && n > maxBytes) throw new HttpError(status, "too_large", message);
}

export type ReadTimeout = {
  idleMs?: number;
  overallMs?: number;
  signal?: AbortSignal;
};

/**
 * Read the next chunk. Always clears the idle timer and abort listener,
 * whether the read succeeds, times out, or the socket drops.
 */
export async function readWithIdle(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted) throw new Error("cancelled");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("idle")), idleMs);
      onAbort = () => reject(new Error("cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      reader.read().then(resolve, (err: unknown) => {
        reject(err instanceof Error ? err : new Error("socket"));
      });
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

function timeoutError(err: unknown): never {
  if (err instanceof HttpError) throw err;
  const message = err instanceof Error ? err.message : "socket";
  if (message === "cancelled") throw new HttpError(499, "cancelled", "The stream was cancelled.");
  if (message === "idle") throw new HttpError(504, "timeout", "The endpoint timed out waiting for the next chunk.");
  throw new HttpError(502, "upstream", "The endpoint connection was lost.");
}

/** Byte-counting reader. Cancels the source as soon as the cap is crossed. Optional idle + overall timeouts. */
export async function readCappedBytes(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
  error: HttpError = new HttpError(413, "too_large", "The request body is too large."),
  timeouts: ReadTimeout = {},
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  const started = Date.now();
  const idleMs = timeouts.idleMs;
  const overallMs = timeouts.overallMs;
  try {
    while (true) {
      if (timeouts.signal?.aborted) throw new HttpError(499, "cancelled", "The stream was cancelled.");
      if (overallMs !== undefined && Date.now() - started > overallMs) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(504, "timeout", "The endpoint took too long.");
      }
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        if (idleMs === undefined && overallMs === undefined && !timeouts.signal) {
          result = await reader.read();
        } else {
          const remaining = overallMs === undefined ? (idleMs ?? 30_000) : Math.max(1, overallMs - (Date.now() - started));
          const wait = idleMs === undefined ? remaining : Math.min(idleMs, remaining);
          result = await readWithIdle(reader, wait, timeouts.signal);
        }
      } catch (err) {
        await reader.cancel().catch(() => undefined);
        timeoutError(err);
      }
      if (result.done) break;
      seen += result.value.byteLength;
      if (seen > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw error;
      }
      chunks.push(result.value);
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
