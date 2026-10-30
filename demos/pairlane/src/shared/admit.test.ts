import { expect, test } from "bun:test";
import { admit } from "./admit";
import { MAX_PEERS } from "./protocol";

test("the creator is the offerer and the second browser is the answerer", () => {
  const first = admit([], "creatorcid1", "creatorcid1");
  expect(first).toEqual({ ok: true, role: "offerer", replaced: false });
  const second = admit([{ cid: "creatorcid1", role: "offerer" }], "guestcidguest", "creatorcid1");
  expect(second).toEqual({ ok: true, role: "answerer", replaced: false });
});

test("a third peer is refused and a reconnect takes the same seat", () => {
  const seats = [
    { cid: "creatorcid1", role: "offerer" as const },
    { cid: "guestcidguest", role: "answerer" as const },
  ];
  expect(seats.length).toBe(MAX_PEERS);
  expect(admit(seats, "anotherpeer1", "creatorcid1")).toEqual({ ok: false, reason: "full" });
  expect(admit(seats, "creatorcid1", "creatorcid1")).toEqual({ ok: true, role: "offerer", replaced: true });
});

test("two guests cannot both sit down before the creator", () => {
  const first = admit([], "guestcidguest", "creatorcid1");
  expect(first).toEqual({ ok: true, role: "answerer", replaced: false });
  const second = admit([{ cid: "guestcidguest", role: "answerer" }], "otherguest12", "creatorcid1");
  expect(second).toEqual({ ok: false, reason: "full" });
  const creator = admit([{ cid: "guestcidguest", role: "answerer" }], "creatorcid1", "creatorcid1");
  expect(creator).toEqual({ ok: true, role: "offerer", replaced: false });
});
