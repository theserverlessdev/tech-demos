import { FROZEN_KEEP_MS } from "../shared/constants";
import { deletePrefix, type DavBucket } from "./bucket";

export type WipeRow = { status: string; expiresAt: number; frozenAt: number | null };

export type WipeDecision = { action: "wipe" } | { action: "defer"; until: number } | { action: "skip" };

/**
 * One decision for the alarm, the request path, and the cron.
 * A frozen drive waits until frozenAt + 30 days. Active drives wipe at expiresAt.
 */
export function wipeDecision(row: WipeRow | null, now: number, options?: { force?: boolean }): WipeDecision {
  if (options?.force) return { action: "wipe" };
  if (!row || row.status === "wiped") return { action: "skip" };
  if (row.status === "frozen") {
    const until = (row.frozenAt ?? row.expiresAt) + FROZEN_KEEP_MS;
    if (now >= until) return { action: "wipe" };
    return { action: "defer", until };
  }
  if (row.expiresAt <= now) return { action: "wipe" };
  return { action: "skip" };
}

export async function runAlarm(input: {
  row: WipeRow | null;
  now: number;
  setAlarm: (at: number) => Promise<void>;
  wipe: (now: number) => Promise<void>;
}): Promise<WipeDecision> {
  const decision = wipeDecision(input.row, input.now);
  if (decision.action === "defer") await input.setAlarm(decision.until);
  else if (decision.action === "wipe") await input.wipe(input.now);
  return decision;
}

/**
 * Wipe the prefix even when the Durable Object name is missing, as long as
 * schedule() stored the drive id. Both missing is a loud failure.
 */
export async function completeWipe(input: {
  name: string | undefined;
  storedId: string | undefined;
  bucket: DavBucket;
  markWiped: (id: string, now: number) => Promise<void>;
  deleteAll: () => Promise<void>;
  now: number;
}): Promise<boolean> {
  if (!input.name) {
    console.error(JSON.stringify({ event: "wipe_missing_name", storedId: input.storedId ?? null }));
  }
  const id = input.name || input.storedId;
  if (!id) return false;
  await deletePrefix(input.bucket, `drives/${id}/`);
  await input.markWiped(id, input.now);
  await input.deleteAll();
  return true;
}
