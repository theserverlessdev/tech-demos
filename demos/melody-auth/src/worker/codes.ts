export type AuthCodeRow = {
  usedAt: number | null;
  expiresAt: number;
};

export type RefreshRow = {
  revokedAt: number | null;
  expiresAt: number;
  familyId: string;
};

export type ConsumeResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "used" | "expired" };

export type RotateResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "expired" | "reused"; revokeFamily: boolean };

export function consumeAuthCode(row: AuthCodeRow | null, now: number): ConsumeResult {
  if (!row) return { ok: false, reason: "missing" };
  if (row.usedAt !== null) return { ok: false, reason: "used" };
  if (row.expiresAt <= now) return { ok: false, reason: "expired" };
  return { ok: true };
}

export function rotateRefreshToken(row: RefreshRow | null, now: number): RotateResult {
  if (!row) return { ok: false, reason: "missing", revokeFamily: false };
  if (row.revokedAt !== null) return { ok: false, reason: "reused", revokeFamily: true };
  if (row.expiresAt <= now) return { ok: false, reason: "expired", revokeFamily: false };
  return { ok: true };
}
