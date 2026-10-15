import { expect, test } from "bun:test";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  MAX_BYTES_PER_SEC,
  MAX_FRAME_BYTES,
  MAX_STROKES,
  cleanName,
  isInk,
  parseStroke,
} from "./protocol";

test("a full resync frame is not slower than the byte budget", () => {
  expect(MAX_BYTES_PER_SEC).toBeGreaterThanOrEqual(MAX_FRAME_BYTES);
});

test("the logical board is 4:3", () => {
  expect(BOARD_WIDTH / BOARD_HEIGHT).toBeCloseTo(4 / 3);
});

test("parseStroke keeps a valid ember stroke", () => {
  const raw = JSON.stringify({
    id: "stroke01",
    color: "#c2410c",
    size: 6,
    points: [100, 100, 4000, 7000],
    client: "smokecli",
  });
  expect(parseStroke(raw)?.id).toBe("stroke01");
});

test("parseStroke drops junk and non-json", () => {
  expect(parseStroke("not-json")).toBeNull();
  expect(parseStroke(JSON.stringify({ id: "stroke01" }))).toBeNull();
  expect(MAX_STROKES).toBe(240);
});

test("cleanName and isInk bound presence", () => {
  expect(cleanName(`  ${"a".repeat(80)}  `).length).toBe(24);
  expect(isInk("#c2410c")).toBe(true);
  expect(isInk("red")).toBe(false);
});
