import { DurableObject } from "cloudflare:workers";
import { availabilityFromLocks, findGeneratedSlot, slotOverlapsBusy } from "../shared/schedule";
import type { Availability, BookRequest, BookResult } from "../shared/types";
import { GOOGLE_CACHE_TTL, hostFromEnv } from "./config";
import { cancelBooking, getBooking, insertBooking, isUniqueError, listTakenStarts, newId } from "./db";
import { loadBusyIntervals, queryFreeBusy } from "./google";

const CACHE_KEY = (hostId: string) => `avail:${hostId}`;
const CACHE_TTL = 60;

export class Calendar extends DurableObject<Env> {
  async availability(): Promise<Availability> {
    const host = hostFromEnv(this.env);
    const cached = await this.env.CACHE.get(CACHE_KEY(host.id), "json");
    if (cached && typeof cached === "object") {
      const hit = cached as Omit<Availability, "source">;
      return { ...hit, source: "kv", host, google: hit.google ?? "off" };
    }
    const taken = await listTakenStarts(this.env.DB, host.id);
    const { google, busy } = await loadBusyIntervals(this.env, host);
    const days = availabilityFromLocks(host, taken, Date.now(), busy);
    const payload: Availability = { host, source: "d1", google, days };
    await this.env.CACHE.put(CACHE_KEY(host.id), JSON.stringify({ host, google, days }), {
      expirationTtl: google === "off" ? CACHE_TTL : GOOGLE_CACHE_TTL,
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

    const { busy } = await loadBusyIntervals(this.env, host);
    if (slotOverlapsBusy(slot, busy)) {
      await this.env.CACHE.delete(CACHE_KEY(host.id));
      return { ok: false, code: "slot_taken", message: "That slot is busy on Google Calendar. Pick another time." };
    }

    const live = await queryFreeBusy(this.env, host, { timeMin: slot.start, timeMax: slot.end });
    if (live.ok && slotOverlapsBusy(slot, live.busy)) {
      await this.env.CACHE.delete(CACHE_KEY(host.id));
      return { ok: false, code: "slot_taken", message: "That slot is busy on Google Calendar. Pick another time." };
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
