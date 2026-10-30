import { expect, test } from "bun:test";
import { freshBudget, takeFrame, takeSignal, MAX_CANDIDATES, MAX_FRAMES_PER_SECOND, MAX_SDP_EACH } from "./budget";

test("each socket allows two offers, 64 candidates, and 20 frames a second", () => {
  const offers = freshBudget(0);
  expect(takeSignal(offers, "offer")).toBe("ok");
  expect(takeSignal(offers, "offer")).toBe("ok");
  expect(takeSignal(offers, "offer")).toBe("type");
  expect(MAX_SDP_EACH).toBe(2);

  const candidates = freshBudget(0);
  for (let i = 0; i < MAX_CANDIDATES; i++) expect(takeSignal(candidates, "candidate")).toBe("ok");
  expect(takeSignal(candidates, "candidate")).toBe("type");

  const rate = freshBudget(1_000);
  for (let i = 0; i < MAX_FRAMES_PER_SECOND; i++) expect(takeFrame(rate, 1_050)).toBe("ok");
  expect(takeFrame(rate, 1_050)).toBe("rate");
  expect(takeFrame(rate, 2_050)).toBe("ok");
});
