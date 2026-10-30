import { expect, test } from "bun:test";
import { chunkCount, classifyData, rateLabel, reduceRecv, safeName, sendFile, sha256Hex, type ByteChannel } from "./file";
import { CHUNK_SIZE } from "./protocol";

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
