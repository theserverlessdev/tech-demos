import { describe, expect, test } from "bun:test";
import { normalizeDraft, usableDraft } from "../src/worker/ai";

describe("draft validator", () => {
  test("accepts a realistic greeting after stripping markdown and Subject", () => {
    const raw = `Subject: Re: invoice\n\n**Hi Priya,**\n\nThanks for writing in about the duplicate March charge. I can see INV-8841 on the ledger and I am checking the reversal window with finance before I promise a date. Please confirm the card last four if it is not already on the note.\n\nMaya Chen`;
    const text = normalizeDraft(raw);
    expect(text.startsWith("Hi Priya")).toBe(true);
    expect(usableDraft(text)).toBe(true);
  });

  test("rejects empty or leaked prompt text", () => {
    expect(usableDraft("Hi")).toBe(false);
    expect(usableDraft("Ticket JSON: {\"number\":1} output only the email")).toBe(false);
  });
});
