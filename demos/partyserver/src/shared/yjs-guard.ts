import * as Y from "yjs";
import { STROKE_ID } from "./protocol";

/** y-protocols: messageSync. */
const MESSAGE_SYNC = 0;
/** y-protocols sync: messageYjsSyncStep2. */
const MESSAGE_YJS_STEP2 = 1;
/** y-protocols sync: messageYjsUpdate. */
const MESSAGE_YJS_UPDATE = 2;

type YStruct = {
  constructor: { name: string };
  id: { client: number; clock: number };
  length?: number;
  parent?: unknown;
  parentSub?: unknown;
};

function asBytes(message: string | ArrayBuffer | ArrayBufferView): Uint8Array | null {
  if (typeof message === "string") return null;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
}

function readVarUint(bytes: Uint8Array, offset: { i: number }): number {
  let num = 0;
  let shift = 0;
  while (true) {
    if (offset.i >= bytes.length) throw new Error("eof");
    const bits = bytes[offset.i]!;
    offset.i += 1;
    num |= (bits & 127) << shift;
    if (bits < 128) return num >>> 0;
    shift += 7;
    if (shift >= 35) throw new Error("overflow");
  }
}

/**
 * Pull the Yjs update out of a y-protocols sync step-2 or update frame.
 * Awareness, sync step 1, and anything we cannot parse return null.
 */
export function extractSyncUpdate(message: string | ArrayBuffer | ArrayBufferView): Uint8Array | null {
  const bytes = asBytes(message);
  if (!bytes || bytes.byteLength === 0) return null;
  try {
    const offset = { i: 0 };
    const outer = readVarUint(bytes, offset);
    if (outer !== MESSAGE_SYNC) return null;
    const inner = readVarUint(bytes, offset);
    if (inner !== MESSAGE_YJS_STEP2 && inner !== MESSAGE_YJS_UPDATE) return null;
    const length = readVarUint(bytes, offset);
    if (offset.i + length > bytes.length) return null;
    return bytes.subarray(offset.i, offset.i + length);
  } catch {
    return null;
  }
}

function writeVarUint(n: number): Uint8Array {
  const bytes: number[] = [];
  let value = n;
  while (value > 127) {
    bytes.push((value & 127) | 128);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function decodeStructs(update: Uint8Array): YStruct[] {
  const decoded = Y.decodeUpdate(update) as { structs: YStruct[] };
  return decoded.structs;
}

function nextClock(doc: Y.Doc, client: number): number {
  return Y.decodeStateVector(Y.encodeStateVector(doc)).get(client) ?? 0;
}

/** True when a client’s structs start past the next expected clock, or leave a hole. */
export function updateSkipsAhead(doc: Y.Doc, update: Uint8Array): boolean {
  const byClient = new Map<number, Array<{ clock: number; length: number }>>();
  for (const struct of decodeStructs(update)) {
    if (struct.constructor.name === "Skip") return true;
    const list = byClient.get(struct.id.client) ?? [];
    list.push({ clock: struct.id.clock, length: struct.length ?? 1 });
    byClient.set(struct.id.client, list);
  }
  for (const [client, structs] of byClient) {
    structs.sort((a, b) => a.clock - b.clock);
    const expected = nextClock(doc, client);
    if (structs[0]!.clock > expected) return true;
    let end = expected;
    for (const struct of structs) {
      if (struct.clock > end) return true;
      end = Math.max(end, struct.clock + struct.length);
    }
  }
  return false;
}

/**
 * True when decoded items include junk keys, list items under strokes, or a foreign root.
 * Uses `Y.decodeUpdate` so follow-on updates are visible without applying them.
 */
export function updateCarriesJunk(update: Uint8Array): boolean {
  for (const struct of decodeStructs(update)) {
    const parent = struct.parent;
    const parentSub = struct.parentSub;
    if (typeof parent === "string") {
      if (parent !== "strokes") return true;
      if (typeof parentSub !== "string") return true;
      if (!STROKE_ID.test(parentSub)) return true;
    } else if (typeof parentSub === "string" && !STROKE_ID.test(parentSub)) {
      return true;
    }
  }
  return false;
}

/** Drop Yjs pending structs left by a gap so they cannot bloat encodeStateAsUpdate. */
export function dropPendingUpdates(doc: Y.Doc): void {
  const store = (doc as unknown as { store?: { pendingStructs: unknown; pendingDs: unknown } }).store;
  if (!store) return;
  store.pendingStructs = null;
  store.pendingDs = null;
}

/** y-protocols sync step 1: ask the peer to send everything this document is missing. */
export function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const sv = Y.encodeStateVector(doc);
  return concatBytes(writeVarUint(MESSAGE_SYNC), writeVarUint(0), writeVarUint(sv.byteLength), sv);
}

export type FrameVerdict = "ok" | "junk" | "ahead";

/**
 * Classify a sync step-2 or update frame. Awareness and sync step 1 are `ok`.
 * Junk (bad keys, list items, foreign roots) is distinct from clock gaps so a
 * reconnecting client is not locked out with a fatal close.
 */
export function inspectSyncFrame(doc: Y.Doc, message: string | ArrayBuffer | ArrayBufferView): FrameVerdict {
  const update = extractSyncUpdate(message);
  if (!update) return "ok";
  try {
    if (updateCarriesJunk(update)) return "junk";
    if (updateSkipsAhead(doc, update)) return "ahead";
    return "ok";
  } catch {
    return "junk";
  }
}
