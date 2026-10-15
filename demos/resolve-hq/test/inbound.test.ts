import { describe, expect, test } from "bun:test";
import { PermanentInboundError } from "../src/worker/errors";
import { validateInboundFields } from "../src/worker/inbound";

describe("inbound validation", () => {
  test("rejects empty body and blank email", () => {
    expect(() => validateInboundFields({ fromEmail: "a@b.co", body: "   " })).toThrow(PermanentInboundError);
    expect(() => validateInboundFields({ fromEmail: "", body: "hello" })).toThrow(PermanentInboundError);
    expect(() => validateInboundFields({ fromEmail: "not-an-email", body: "hello" })).toThrow(PermanentInboundError);
  });

  test("rejects a bad ticket id and accepts a good one", () => {
    expect(() => validateInboundFields({ fromEmail: "a@b.co", body: "hello", ticketId: "../x" })).toThrow(PermanentInboundError);
    expect(() => validateInboundFields({ fromEmail: "a@b.co", body: "hello", ticketId: "tkt_billing" })).not.toThrow();
  });
});
