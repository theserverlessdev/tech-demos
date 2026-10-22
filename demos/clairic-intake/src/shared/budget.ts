import { LIMITS } from "./limits";

export type LimitName = "extract" | "compare" | "decide" | "batch" | "upload" | "read" | "review";

export function rateLimitResult(success: boolean): { ok: true } | { ok: false; code: "rate_limited"; message: string } {
  if (success) return { ok: true };
  return {
    ok: false,
    code: "rate_limited",
    message: "Too many requests from this network. Wait a minute and try again.",
  };
}

export function budgetDecision(
  used: number,
  adding: number,
  cap = LIMITS.dailyCalls,
): { ok: true; remaining: number } | { ok: false; code: "budget"; message: string } {
  if (!Number.isInteger(adding) || adding < 1) {
    return { ok: false, code: "budget", message: "Nothing to reserve." };
  }
  if (!Number.isInteger(used) || used < 0) {
    return { ok: false, code: "budget", message: "The daily budget could not be read." };
  }
  if (used + adding > cap) {
    const left = Math.max(0, cap - used);
    return {
      ok: false,
      code: "budget",
      message: `This network has ${left} paid call${left === 1 ? "" : "s"} left today.`,
    };
  }
  return { ok: true, remaining: cap - used - adding };
}

export type GuardCheck = {
  bodyBytes: number;
  stateChars: number;
  images: number;
  imageBytes: number;
  remoteImage: boolean;
  turnstileOk: boolean;
  rateOk: boolean;
  budgetOk: boolean;
};

/**
 * Pure intake guard. No I/O, so a later shared guardrails package can re-export it.
 * Callers still run Turnstile, the rate-limit binding, and the D1 reserve themselves.
 */
export function guardFailure(input: GuardCheck): { code: string; message: string } | null {
  if (input.bodyBytes > LIMITS.maxBodyBytes) {
    return { code: "too_large", message: "That request is too large." };
  }
  if (input.remoteImage) {
    return { code: "bad_image", message: "Images must be uploaded. This desk does not fetch URLs." };
  }
  if (input.images > LIMITS.maxImages) {
    return { code: "bad_image", message: "Upload one image at a time." };
  }
  if (input.imageBytes > LIMITS.maxImageBytes) {
    return { code: "too_large", message: "That image is over the 1.5 MB limit." };
  }
  if (input.stateChars > LIMITS.maxStateChars) {
    return { code: "too_large", message: `Keep the text under ${LIMITS.maxStateChars.toLocaleString("en-US")} characters.` };
  }
  if (!input.turnstileOk) {
    return { code: "turnstile_failed", message: "The Turnstile check did not pass." };
  }
  if (!input.rateOk) {
    return { code: "rate_limited", message: "Too many requests from this network. Wait a minute and try again." };
  }
  if (!input.budgetOk) {
    return { code: "budget", message: "This network has no paid calls left today." };
  }
  return null;
}

export function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}
