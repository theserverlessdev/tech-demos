import { expect, test } from "bun:test";
import { cleanLine, displayName, HttpError, requireSameSite, stripControls } from "./src/worker/http";
import { stripJpegExif } from "./src/worker/images";

test("stripControls drops bidi and zero-width marks and collapses space", () => {
  expect(stripControls("Dark\nmode\u202e\u200b  roadmap")).toBe("Dark mode roadmap");
});

test("cleanLine rejects a title that is only format characters", () => {
  expect(() => cleanLine("\u202e\u200b", 4, 120, "Title")).toThrow(HttpError);
});

test("displayName still rejects emails after cleaning", () => {
  expect(() => displayName("a@b.example")).toThrow(HttpError);
  expect(displayName("Mina")).toBe("Mina");
});

test("requireSameSite rejects a cross-site Origin", () => {
  const request = new Request("http://127.0.0.1:8787/api/posts/post_x/vote", {
    method: "POST",
    headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
  });
  expect(() => requireSameSite(request)).toThrow(HttpError);
});

test("requireSameSite allows a missing Origin (smoke / curl)", () => {
  const request = new Request("http://127.0.0.1:8787/api/posts/post_x/vote", { method: "POST" });
  expect(() => requireSameSite(request)).not.toThrow();
});

test("stripJpegExif drops an APP1 segment and keeps the SOI", () => {
  const jpeg = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe1, 0x00, 0x06, 0x45, 0x78, 0x00, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xff, 0xd9,
  ]);
  const stripped = stripJpegExif(jpeg);
  expect(stripped[0]).toBe(0xff);
  expect(stripped[1]).toBe(0xd8);
  expect([...stripped]).not.toContain(0xe1);
  expect(stripped.length).toBeLessThan(jpeg.length);
});
