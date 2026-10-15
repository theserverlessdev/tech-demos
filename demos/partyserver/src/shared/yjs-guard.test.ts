import { expect, test } from "bun:test";
import * as Y from "yjs";
import {
  extractSyncUpdate,
  inspectSyncFrame,
  updateCarriesJunk,
  updateSkipsAhead,
} from "./yjs-guard";

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

function wrapSync(update: Uint8Array, inner = 2): Uint8Array {
  return concatBytes(varUint(0), varUint(inner), varUint(update.byteLength), update);
}

function validStroke(id = "stroke01"): string {
  return JSON.stringify({ id, color: "#c2410c", size: 6, points: [100, 100, 4000, 7000], client: "smokecli" });
}

function validStrokeUpdate(): Uint8Array {
  const doc = new Y.Doc();
  doc.getMap("strokes").set("stroke01", validStroke());
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function junkKeyUpdate(): Uint8Array {
  const doc = new Y.Doc();
  const map = doc.getMap("strokes");
  for (let i = 0; i < 90; i++) {
    const key = `${i.toString(36).padStart(3, "0")}${"x".repeat(1400)}`.slice(0, 1400);
    map.set(key, "x");
  }
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

test("extractSyncUpdate reads a y-protocols update frame", () => {
  const update = validStrokeUpdate();
  const extracted = extractSyncUpdate(wrapSync(update));
  expect(extracted).not.toBeNull();
  expect(extracted!.byteLength).toBe(update.byteLength);
  expect(updateCarriesJunk(extracted!)).toBe(false);
});

test("extractSyncUpdate reads sync step 2", () => {
  const update = junkKeyUpdate();
  const extracted = extractSyncUpdate(wrapSync(update, 1));
  expect(extracted).not.toBeNull();
  expect(updateCarriesJunk(extracted!)).toBe(true);
  expect(inspectSyncFrame(new Y.Doc(), wrapSync(update, 1))).toBe("junk");
});

test("extractSyncUpdate ignores awareness and sync step 1", () => {
  expect(extractSyncUpdate(concatBytes(varUint(1), varUint(0)))).toBeNull();
  expect(extractSyncUpdate(concatBytes(varUint(0), varUint(0), varUint(0)))).toBeNull();
  expect(inspectSyncFrame(new Y.Doc(), "not-binary")).toBe("ok");
});

test("updateCarriesJunk rejects 1400-character keys", () => {
  const update = junkKeyUpdate();
  expect(update.byteLength).toBeGreaterThan(120_000);
  expect(updateCarriesJunk(update)).toBe(true);
  expect(inspectSyncFrame(new Y.Doc(), wrapSync(update))).toBe("junk");
});

test("follow-on junk keys are visible without applying", () => {
  const doc = new Y.Doc();
  doc.clientID = 9;
  doc.getMap("strokes").set("stroke01", validStroke());
  const first = Y.encodeStateAsUpdate(doc);
  const sv = Y.encodeStateVector(doc);
  for (let i = 0; i < 90; i++) {
    const key = `${i.toString(36).padStart(3, "0")}${"x".repeat(1400)}`.slice(0, 1400);
    doc.getMap("strokes").set(key, "x");
  }
  const follow = Y.encodeStateAsUpdate(doc, sv);
  doc.destroy();

  const room = new Y.Doc();
  Y.applyUpdate(room, first);
  expect(updateSkipsAhead(room, follow)).toBe(false);
  expect(updateCarriesJunk(follow)).toBe(true);
  expect(inspectSyncFrame(room, wrapSync(follow))).toBe("junk");
  room.destroy();
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
  expect(inspectSyncFrame(new Y.Doc(), wrapSync(validStrokeUpdate()))).toBe("ok");
});

test("an update that skips ahead is ahead, not junk", () => {
  const doc = new Y.Doc();
  doc.clientID = 7;
  doc.getMap("strokes").set("skipaa", validStroke("skipaa"));
  const sv = Y.encodeStateVector(doc);
  doc.getMap("strokes").set("skipab", validStroke("skipab"));
  const skip = Y.encodeStateAsUpdate(doc, sv);
  doc.destroy();

  const room = new Y.Doc();
  expect(updateSkipsAhead(room, skip)).toBe(true);
  expect(updateCarriesJunk(skip)).toBe(false);
  expect(inspectSyncFrame(room, wrapSync(skip))).toBe("ahead");
  room.destroy();
});
