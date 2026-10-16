import { expect, test } from "bun:test";
import { rotateRefreshToken } from "../src/worker/codes";

const now = 1_700_000_000_000;
const live = { revokedAt: null, expiresAt: now + 86_400_000, familyId: "fam_1" };

test("a live refresh token rotates", () => {
  expect(rotateRefreshToken(live, now)).toEqual({ ok: true });
});

test("reuse of a rotated token revokes the family", () => {
  expect(rotateRefreshToken({ ...live, revokedAt: now - 10 }, now)).toEqual({
    ok: false,
    reason: "reused",
    revokeFamily: true,
  });
});

test("expired and missing refresh tokens fail without a family wipe", () => {
  expect(rotateRefreshToken({ ...live, expiresAt: now }, now)).toEqual({
    ok: false,
    reason: "expired",
    revokeFamily: false,
  });
  expect(rotateRefreshToken(null, now)).toEqual({ ok: false, reason: "missing", revokeFamily: false });
});
