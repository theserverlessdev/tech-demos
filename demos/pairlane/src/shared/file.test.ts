import { expect, test } from "bun:test";
import { FILE_TOO_LARGE, chunkCount, classifyData, fileFits, joinParts, rateLabel, reduceRecv, safeName, sendFile, sha256Hex, type ByteChannel } from "./file";
import { CHUNK_SIZE, MAX_FILE_BYTES } from "./protocol";

test("file names lose paths and control characters", () => {
  expect(safeName("../secret/../../notes.txt")).toBe("notes.txt");
  expect(safeName("bad\u0000name")).toBe("badname");
  expect(safeName("   ")).toBe("file");
});

test("the receiver stops when the bytes do not match the header", () => {
  const meta = { type: "meta", name: "note.txt", size: 4, mime: "text/plain", sha256: "a".repeat(64) };
  let state = reduceRecv({ phase: "idle" }, JSON.stringify(meta));
  expect(state.phase).toBe("body");
  state = reduceRecv(state, new Uint8Array([1, 2, 3, 4, 5]).buffer);
  expect(state.phase).toBe("error");
  let early = reduceRecv({ phase: "idle" }, JSON.stringify(meta));
  early = reduceRecv(early, new Uint8Array([1, 2]));
  early = reduceRecv(early, JSON.stringify({ type: "done" }));
  expect(early.phase).toBe("error");
});

test("sendFile copies chunks and ends with done", async () => {
  const sent: (string | Uint8Array)[] = [];
  const channel: ByteChannel = {
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    send(data) {
      sent.push(typeof data === "string" ? data : data.slice());
    },
    addEventListener() {},
  };
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const file = new File([bytes], "note.txt", { type: "text/plain" });
  const result = await sendFile(channel, file, { chunkSize: 2 });
  expect(result.size).toBe(5);
  expect(result.sha256).toBe(await sha256Hex(bytes));
  expect(sent.length).toBe(1 + chunkCount(5, 2) + 1);
  const meta = JSON.parse(String(sent[0])) as { type: string; sha256: string };
  expect(meta.type).toBe("meta");
  expect(meta.sha256).toBe(result.sha256);
  expect(sent.at(-1)).toBe(JSON.stringify({ type: "done" }));
  const chunk = sent[1];
  expect(chunk).toBeInstanceOf(Uint8Array);
  if (chunk instanceof Uint8Array) expect([...chunk]).toEqual([1, 2]);
  expect(classifyData(JSON.stringify({ type: "ack", ok: true }))).toEqual({ kind: "ack", ok: true });
  expect(CHUNK_SIZE).toBe(16 * 1024);
  expect(rateLabel(1_500_000, 50)).toBe("28.6 MB/s");
});

test("sendFile rejects a file over 256 MB before reading it", async () => {
  let read = false;
  const channel: ByteChannel = {
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    send() {
      throw new Error("sent");
    },
    addEventListener() {},
  };
  const file = {
    size: MAX_FILE_BYTES + 1,
    name: "big.bin",
    type: "application/octet-stream",
    arrayBuffer() {
      read = true;
      return Promise.resolve(new ArrayBuffer(0));
    },
  } as unknown as File;
  await expect(sendFile(channel, file)).rejects.toThrow(FILE_TOO_LARGE);
  expect(read).toBe(false);
  expect(fileFits(MAX_FILE_BYTES)).toBe(true);
  expect(fileFits(MAX_FILE_BYTES + 1)).toBe(false);
  const over = classifyData(JSON.stringify({ type: "meta", name: "big.bin", size: MAX_FILE_BYTES + 1, mime: "application/octet-stream", sha256: "ab".repeat(32) }));
  expect(over.kind).toBe("oversize");
  const reject = classifyData(JSON.stringify({ type: "reject", reason: FILE_TOO_LARGE }));
  expect(reject).toEqual({ kind: "reject", reason: FILE_TOO_LARGE });
});

test("the receiver keeps owning chunks and releases them after one join", () => {
  const meta = JSON.stringify({ type: "meta", name: "n.bin", size: 4, mime: "application/octet-stream", sha256: "ab".repeat(32) });
  let state = reduceRecv({ phase: "idle" }, meta);
  const owned = new Uint8Array([1, 2]);
  state = reduceRecv(state, owned);
  const backing = new Uint8Array([9, 3, 4, 9]);
  const view = backing.subarray(1, 3);
  state = reduceRecv(state, view);
  if (state.phase !== "body") throw new Error("expected body");
  expect(state.parts[0]).toBe(owned);
  expect(state.parts[1]).not.toBe(view);
  const parts = state.parts;
  expect([...joinParts(parts, 4)]).toEqual([1, 2, 3, 4]);
  expect(parts).toHaveLength(0);
});
