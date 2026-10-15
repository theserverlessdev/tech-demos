import { describe, expect, test } from "bun:test";
import { applyByteRange, parseByteRange } from "../src/shared/range";

describe("byte ranges", () => {
  test("parses a span, a suffix, and a bad header", () => {
    expect(parseByteRange(null, 200)).toEqual({ kind: "none" });
    expect(parseByteRange("bytes=0-99", 200)).toEqual({ kind: "span", offset: 0, length: 100 });
    expect(parseByteRange("bytes=-20", 200)).toEqual({ kind: "suffix", suffix: 20 });
    expect(parseByteRange("bytes=nope", 200)).toEqual({ kind: "bad" });
    expect(parseByteRange("bytes=200-", 200)).toEqual({ kind: "bad" });
  });

  test("slices the body for 206 and rejects a bad range with 416", () => {
    const bytes = Uint8Array.from({ length: 50 }, (_, i) => i);
    const ranged = applyByteRange(bytes, "bytes=0-9");
    expect(ranged.status).toBe(206);
    expect(ranged.contentRange).toBe("bytes 0-9/50");
    expect(ranged.body).toEqual(bytes.subarray(0, 10));
    const suffix = applyByteRange(bytes, "bytes=-4");
    expect(suffix.status).toBe(206);
    expect(suffix.contentRange).toBe("bytes 46-49/50");
    expect(suffix.body).toEqual(bytes.subarray(46));
    const bad = applyByteRange(bytes, "bytes=nope");
    expect(bad.status).toBe(416);
    expect(bad.contentRange).toBe("bytes */50");
    expect(applyByteRange(bytes, null).status).toBe(200);
  });
});
