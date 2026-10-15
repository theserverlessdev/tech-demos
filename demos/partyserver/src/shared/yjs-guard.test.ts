import { expect, test } from "bun:test";
import * as Y from "yjs";
import { extractSyncUpdate, frameCarriesJunk, updateCarriesJunk } from "./yjs-guard";

function varUint(n: number): Uint8Array {
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

function wrapSyncUpdate(update: Uint8Array): Uint8Array {
  return concatBytes(varUint(0), varUint(2), varUint(update.byteLength), update);
}

function validStrokeUpdate(): Uint8Array {
  const doc = new Y.Doc();
  doc.getMap("strokes").set(
    "stroke01",
    JSON.stringify({ id: "stroke01", color: "#c2410c", size: 6, points: [100, 100, 4000, 7000], client: "smokecli" }),
  );
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

test("extractSyncUpdate reads a y-protocols update frame", () => {
  const update = validStrokeUpdate();
  const frame = wrapSyncUpdate(update);
  const extracted = extractSyncUpdate(frame);
  expect(extracted).not.toBeNull();
  expect(extracted!.byteLength).toBe(update.byteLength);
  expect(updateCarriesJunk(extracted!)).toBe(false);
});

test("extractSyncUpdate ignores awareness and sync step 1", () => {
  expect(extractSyncUpdate(concatBytes(varUint(1), varUint(0)))).toBeNull();
  expect(extractSyncUpdate(concatBytes(varUint(0), varUint(0), varUint(0)))).toBeNull();
  expect(frameCarriesJunk("not-binary")).toBe(false);
});

test("updateCarriesJunk rejects 1400-character keys", () => {
  const doc = new Y.Doc();
  const map = doc.getMap("strokes");
  for (let i = 0; i < 90; i++) {
    const key = `${i.toString(36).padStart(3, "0")}${"x".repeat(1400)}`.slice(0, 1400);
    map.set(key, "x");
  }
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  expect(update.byteLength).toBeGreaterThan(120_000);
  expect(updateCarriesJunk(update)).toBe(true);
  expect(frameCarriesJunk(wrapSyncUpdate(update))).toBe(true);
});

test("updateCarriesJunk rejects list items on strokes", () => {
  const doc = new Y.Doc();
  doc.getArray("strokes").insert(0, ["wipe"]);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  expect(updateCarriesJunk(update)).toBe(true);
});

test("updateCarriesJunk rejects a foreign root", () => {
  const doc = new Y.Doc();
  doc.getText("junk").insert(0, "x".repeat(200));
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  expect(updateCarriesJunk(update)).toBe(true);
});

test("a valid stroke frame is not junk", () => {
  expect(frameCarriesJunk(wrapSyncUpdate(validStrokeUpdate()))).toBe(false);
});
