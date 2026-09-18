import { DurableObject } from "cloudflare:workers";
import { availabilityFromLocks, findGeneratedSlot, HOST } from "../shared/schedule";
import type { Availability, BookRequest, BookResult, ReminderMessage } from "../shared/types";
import { getBooking, insertBooking, isUniqueError, listTakenStarts, newId } from "./db";

const CACHE_KEY = (hostId: string) => `avail:${hostId}`;
const CACHE_TTL = 60;

export class Calendar extends DurableObject<Env> {
  async availability(): Promise<Availability> {
    const cached = await this.env.CACHE.get(CACHE_KEY(this.hostId), "json");
    if (cached && typeof cached === "object") {
      return { ...(cached as Omit<Availability, "source">), source: "kv", host: HOST };
    }
    const taken = await listTakenStarts(this.env.DB, this.hostId);
    const days = availabilityFromLocks(taken);
    const payload: Availability = { host: HOST, source: "d1", days };
    await this.env.CACHE.put(CACHE_KEY(this.hostId), JSON.stringify({ host: HOST, days }), {
      expirationTtl: CACHE_TTL,
    });
    return payload;
  }

  async book(input: BookRequest): Promise<BookResult> {
    const slot = findGeneratedSlot(input.slotStart);
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
        hostId: this.hostId,
        guestName: input.guestName,
        guestEmail: input.guestEmail,
        slotStart: slot.start,
        slotEnd: slot.end,
        now,
      });
    } catch (err) {
      if (isUniqueError(err)) {
        await this.env.CACHE.delete(CACHE_KEY(this.hostId));
        return { ok: false, code: "slot_taken", message: "That slot was just booked. Pick another time." };
      }
      throw err;
    }

    await this.env.CACHE.delete(CACHE_KEY(this.hostId));
    const reminder: ReminderMessage = {
      bookingId: id,
      hostId: this.hostId,
      guestName: input.guestName,
      guestEmail: input.guestEmail,
      slotStart: slot.start,
      kind: "reminder",
    };
    await this.env.REMINDERS.send(reminder);

    const booking = await getBooking(this.env.DB, id);
    if (!booking) throw new Error("booking missing after insert");
    return { ok: true, booking };
  }

  private get hostId(): string {
    return this.env.HOST_ID || HOST.id;
  }
}

export function calendarStub(env: Env, hostId = env.HOST_ID || HOST.id) {
  return env.CALENDAR.getByName(hostId);
}

export { CACHE_KEY };
