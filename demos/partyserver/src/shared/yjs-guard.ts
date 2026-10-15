import * as Y from "yjs";
import { STROKE_ID } from "./protocol";

type StartItem = { deleted: boolean; right: StartItem | null };

/** y-protocols: messageSync. */
const MESSAGE_SYNC = 0;
/** y-protocols sync: messageYjsUpdate. */
const MESSAGE_YJS_UPDATE = 2;

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
 * Pull the Yjs update out of a y-protocols sync-update frame.
 * Awareness, sync step 1/2, and anything we cannot parse return null.
 */
export function extractSyncUpdate(message: string | ArrayBuffer | ArrayBufferView): Uint8Array | null {
  const bytes = asBytes(message);
  if (!bytes || bytes.byteLength === 0) return null;
  try {
    const offset = { i: 0 };
    const outer = readVarUint(bytes, offset);
    if (outer !== MESSAGE_SYNC) return null;
    const inner = readVarUint(bytes, offset);
    if (inner !== MESSAGE_YJS_UPDATE) return null;
    const length = readVarUint(bytes, offset);
    if (offset.i + length > bytes.length) return null;
    return bytes.subarray(offset.i, offset.i + length);
  } catch {
    return null;
  }
}

/** True when applying this update on an empty doc would introduce junk keys, list items, or foreign roots. */
export function updateCarriesJunk(update: Uint8Array): boolean {
  const doc = new Y.Doc();
  doc.getMap("strokes");
  try {
    Y.applyUpdate(doc, update);
    for (const name of doc.share.keys()) {
      if (name !== "strokes") return true;
    }
    const strokes = doc.getMap("strokes");
    for (const key of strokes.keys()) {
      if (!STROKE_ID.test(key)) return true;
    }
    let item = (strokes as unknown as { _start: StartItem | null })._start;
    while (item) {
      if (!item.deleted) return true;
      item = item.right;
    }
    return false;
  } catch {
    return true;
  } finally {
    doc.destroy();
  }
}

/** True for a y-protocols sync-update whose payload would poison the strokes map. Other frames are left alone. */
export function frameCarriesJunk(message: string | ArrayBuffer | ArrayBufferView): boolean {
  const update = extractSyncUpdate(message);
  if (!update) return false;
  return updateCarriesJunk(update);
}
