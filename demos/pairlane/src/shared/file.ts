import { CHUNK_SIZE, MAX_FILE_BYTES } from "./protocol";

/** Browser data-channel messages. The Durable Object never sees these. */
export type FileMeta = {
  name: string;
  size: number;
  mime: string;
  sha256: string;
};

export type DataKind =
  | { kind: "meta"; meta: FileMeta }
  | { kind: "chunk"; bytes: Uint8Array }
  | { kind: "done" }
  | { kind: "ack"; ok: boolean }
  | { kind: "busy" }
  | { kind: "ignore" };

export function safeName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "file";
  const cleaned = base.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 180);
  return cleaned || "file";
}

export function parseMeta(value: unknown): FileMeta | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "meta") return null;
  if (typeof record.name !== "string") return null;
  if (typeof record.size !== "number" || !Number.isInteger(record.size)) return null;
  if (record.size < 0 || record.size > MAX_FILE_BYTES) return null;
  if (typeof record.mime !== "string") return null;
  if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) return null;
  return {
    name: safeName(record.name),
    size: record.size,
    mime: record.mime.replace(/[\u0000-\u001f]/g, "").slice(0, 120) || "application/octet-stream",
    sha256: record.sha256,
  };
}

export function classifyData(data: string | ArrayBuffer | Uint8Array): DataKind {
  if (typeof data !== "string") {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    return { kind: "chunk", bytes };
  }
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return { kind: "ignore" };
  }
  if (!value || typeof value !== "object") return { kind: "ignore" };
  const record = value as Record<string, unknown>;
  if (record.type === "meta") {
    const meta = parseMeta(record);
    return meta ? { kind: "meta", meta } : { kind: "ignore" };
  }
  if (record.type === "done") return { kind: "done" };
  if (record.type === "ack") return { kind: "ack", ok: record.ok === true };
  if (record.type === "busy") return { kind: "busy" };
  return { kind: "ignore" };
}

export type RecvState =
  | { phase: "idle" }
  | { phase: "body"; meta: FileMeta; parts: Uint8Array[]; got: number }
  | { phase: "done"; meta: FileMeta; parts: Uint8Array[] }
  | { phase: "error"; reason: string };

export function reduceRecv(state: RecvState, data: string | ArrayBuffer | Uint8Array): RecvState {
  const kind = classifyData(data);
  if (state.phase === "error" || state.phase === "done") return state;
  if (state.phase === "idle") {
    if (kind.kind === "meta") return { phase: "body", meta: kind.meta, parts: [], got: 0 };
    if (kind.kind === "chunk" || kind.kind === "done") return { phase: "error", reason: "The file header never arrived." };
    return state;
  }
  if (kind.kind === "chunk") {
    if (state.got + kind.bytes.byteLength > state.meta.size) {
      return { phase: "error", reason: "The file is larger than its header." };
    }
    const copy = kind.bytes.slice();
    return { phase: "body", meta: state.meta, parts: [...state.parts, copy], got: state.got + copy.byteLength };
  }
  if (kind.kind === "done") {
    if (state.got !== state.meta.size) return { phase: "error", reason: "The file ended early." };
    return { phase: "done", meta: state.meta, parts: state.parts };
  }
  return state;
}

export function chunkCount(size: number, chunk = CHUNK_SIZE): number {
  if (size <= 0) return 0;
  return Math.ceil(size / chunk);
}

export type ByteChannel = {
  send(data: string | Uint8Array): void;
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  addEventListener(type: "bufferedamountlow", listener: () => void, options?: { once?: boolean }): void;
};

export async function sha256Hex(data: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function rateLabel(bytes: number, elapsedMs: number): string {
  if (bytes <= 0) return "starting";
  const ms = Math.max(elapsedMs, 1);
  const perSec = bytes / (ms / 1000);
  if (perSec >= 1024 * 1024) return `${(perSec / (1024 * 1024)).toFixed(1)} MB/s`;
  if (perSec >= 1024) return `${Math.round(perSec / 1024)} KB/s`;
  return `${Math.round(perSec)} B/s`;
}

/**
 * Send meta, then copied chunks, then done. Copies each view so a Uint8Array
 * window cannot leak the rest of the file into one data-channel message.
 */
export async function sendFile(
  channel: ByteChannel,
  file: Blob & { name?: string },
  opts?: { chunkSize?: number; onProgress?: (sent: number, total: number, elapsedMs: number) => void },
): Promise<{ sha256: string; name: string; size: number }> {
  const chunkSize = opts?.chunkSize ?? CHUNK_SIZE;
  const buf = await file.arrayBuffer();
  const sha256 = await sha256Hex(buf);
  const name = safeName(file.name ?? "file");
  const mime = file.type || "application/octet-stream";
  channel.bufferedAmountLowThreshold = 256 * 1024;
  channel.send(JSON.stringify({ type: "meta", name, size: buf.byteLength, mime, sha256 }));
  const view = new Uint8Array(buf);
  const started = performance.now();
  let offset = 0;
  while (offset < view.length) {
    if (channel.bufferedAmount > 1024 * 1024) {
      await new Promise<void>((resolve) => {
        channel.addEventListener("bufferedamountlow", () => resolve(), { once: true });
      });
    }
    const end = Math.min(offset + chunkSize, view.length);
    channel.send(view.slice(offset, end));
    offset = end;
    opts?.onProgress?.(offset, view.length, performance.now() - started);
  }
  channel.send(JSON.stringify({ type: "done" }));
  return { sha256, name, size: buf.byteLength };
}
