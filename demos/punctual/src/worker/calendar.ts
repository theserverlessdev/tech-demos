import { DurableObject } from "cloudflare:workers";
import { availabilityFromLocks, findGeneratedSlot } from "../shared/schedule";
import type { Availability, BookRequest, BookResult } from "../shared/types";
import { hostFromEnv } from "./config";
import { cancelBooking, getBooking, insertBooking, isUniqueError, listTakenStarts, newId } from "./db";

const CACHE_KEY = (hostId: string) => `avail:${hostId}`;
const CACHE_TTL = 60;

export class Calendar extends DurableObject<Env> {
  async availability(): Promise<Availability> {
    const host = hostFromEnv(this.env);
    const cached = await this.env.CACHE.get(CACHE_KEY(host.id), "json");
    if (cached && typeof cached === "object") {
      return { ...(cached as Omit<Availability, "source">), source: "kv", host };
    }
    const taken = await listTakenStarts(this.env.DB, host.id);
    const days = availabilityFromLocks(host, taken);
    const payload: Availability = { host, source: "d1", days };
    await this.env.CACHE.put(CACHE_KEY(host.id), JSON.stringify({ host, days }), {
      expirationTtl: CACHE_TTL,
    });
    return payload;
  }

  async book(input: BookRequest): Promise<BookResult> {
    const host = hostFromEnv(this.env);
    const slot = findGeneratedSlot(host, input.slotStart);
    if (!slot) {
      const past = Number.isFinite(Date.parse(input.slotStart)) && Date.parse(input.slotStart) <= Date.now();
      return {
        ok: false,
        code: past ? "slot_past" : "slot_invalid",
        message: past ? "That slot is already in the past." : "That slot is not on this calendar.",
      };
    }

    const id = newId("bk");
    const now = Date.now();
    try {
      await insertBooking(this.env.DB, {
        id,
        hostId: host.id,
        guestName: input.guestName,
        guestEmail: input.guestEmail,
        slotStart: slot.start,
        slotEnd: slot.end,
        now,
      });
    } catch (err) {
      if (isUniqueError(err)) {
        await this.env.CACHE.delete(CACHE_KEY(host.id));
        return { ok: false, code: "slot_taken", message: "That slot was just booked. Pick another time." };
      }
      throw err;
    }

    await this.env.CACHE.delete(CACHE_KEY(host.id));
    const booking = await getBooking(this.env.DB, id);
    if (!booking) throw new Error("booking missing after insert");
    return { ok: true, booking };
  }

  async cancel(bookingId: string): Promise<{ ok: boolean; booking: Awaited<ReturnType<typeof getBooking>> }> {
    const host = hostFromEnv(this.env);
    const booking = await getBooking(this.env.DB, bookingId);
    if (!booking || booking.hostId !== host.id) return { ok: false, booking: null };
    const changed = await cancelBooking(this.env.DB, booking, Date.now());
    await this.env.CACHE.delete(CACHE_KEY(host.id));
    return { ok: changed, booking: await getBooking(this.env.DB, bookingId) };
  }
}

export function calendarStub(env: Env) {
  return env.CALENDAR.getByName(hostFromEnv(env).id);
}

export { CACHE_KEY };
