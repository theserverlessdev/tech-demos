/** Per-socket signalling budget. Stops a peer from filling Durable Object storage. */

export const MAX_SDP_EACH = 2;
export const MAX_CANDIDATES = 64;
export const MAX_FRAMES = 120;
export const MAX_FRAMES_PER_SECOND = 20;
export const MAX_BAD_FRAMES = 5;

export type FrameBudget = {
  frames: number;
  offers: number;
  answers: number;
  candidates: number;
  bad: number;
  windowStart: number;
  windowCount: number;
};

export function freshBudget(now: number): FrameBudget {
  return { frames: 0, offers: 0, answers: 0, candidates: 0, bad: 0, windowStart: now, windowCount: 0 };
}

/** Count one received frame. `rate` and `total` both mean the socket should close. */
export function takeFrame(budget: FrameBudget, now: number): "ok" | "rate" | "total" {
  if (now - budget.windowStart >= 1000) {
    budget.windowStart = now;
    budget.windowCount = 0;
  }
  budget.windowCount += 1;
  budget.frames += 1;
  if (budget.windowCount > MAX_FRAMES_PER_SECOND) return "rate";
  if (budget.frames > MAX_FRAMES) return "total";
  return "ok";
}

export function takeSignal(budget: FrameBudget, kind: "offer" | "answer" | "candidate"): "ok" | "type" {
  if (kind === "offer") {
    budget.offers += 1;
    if (budget.offers > MAX_SDP_EACH) return "type";
  } else if (kind === "answer") {
    budget.answers += 1;
    if (budget.answers > MAX_SDP_EACH) return "type";
  } else {
    budget.candidates += 1;
    if (budget.candidates > MAX_CANDIDATES) return "type";
  }
  return "ok";
}
