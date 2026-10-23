import { expect, test } from "bun:test";
import { LITMUS_RESULTS } from "./litmus-results";

test("litmus results are empty until a real run records raw output", () => {
  if (!LITMUS_RESULTS.ran) {
    expect(LITMUS_RESULTS.suites).toEqual([]);
    expect(LITMUS_RESULTS.note.toLowerCase()).toContain("not");
    return;
  }
  expect(LITMUS_RESULTS.command).toBeTruthy();
  expect(LITMUS_RESULTS.suites.length).toBeGreaterThan(0);
  for (const suite of LITMUS_RESULTS.suites) expect(suite.raw.trim().length).toBeGreaterThan(0);
});
