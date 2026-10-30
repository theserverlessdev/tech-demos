import { MAX_PEERS, type Role } from "./protocol";

export type Seat = { cid: string; role: Role };

export type Admit =
  | { ok: true; role: Role; replaced: boolean }
  | { ok: false; reason: "full" };

/**
 * Two seats: the room creator is the offerer, the other browser is the answerer.
 * The same cid reconnects into its own seat.
 */
export function admit(seats: Seat[], cid: string, creatorCid: string): Admit {
  const existing = seats.find((seat) => seat.cid === cid);
  if (existing) return { ok: true, role: existing.role, replaced: true };
  if (seats.length >= MAX_PEERS) return { ok: false, reason: "full" };
  if (cid === creatorCid) {
    if (seats.some((seat) => seat.role === "offerer")) return { ok: false, reason: "full" };
    return { ok: true, role: "offerer", replaced: false };
  }
  if (seats.some((seat) => seat.role === "answerer")) return { ok: false, reason: "full" };
  return { ok: true, role: "answerer", replaced: false };
}
