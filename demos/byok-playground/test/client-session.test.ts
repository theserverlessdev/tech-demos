import { describe, expect, test } from "bun:test";
import { remountCompareAfterMint, tokenForSessionMint, type TurnstileWidget } from "../src/client/session-mint";
import { dropOldestUntilFits, utf8ByteLength } from "../src/shared/text";
import { LIMITS } from "../src/shared/limits";

function stubWidget(initial: "session" | "compare" | null = "compare"): TurnstileWidget & { log: string[] } {
  const log: string[] = [];
  const widget: TurnstileWidget & { log: string[] } = {
    action: initial,
    log,
    mount(action) {
      this.action = action;
      log.push(`mount:${action}`);
    },
    async takeToken() {
      log.push(`token:${this.action}`);
      return `tok-${this.action}-1`;
    },
  };
  return widget;
}

describe("session remint uses a session-action widget", () => {
  test("remounts session when compare is showing, then remounts compare", async () => {
    const widget = stubWidget("compare");
    const token = await tokenForSessionMint(widget, { siteKey: "0x4AAAAAAAreal", testSiteKey: false, dummy: "XXXX.DUMMY.TOKEN.XXXX" });
    expect(token).toBe("tok-session-1");
    remountCompareAfterMint(widget, { siteKey: "0x4AAAAAAAreal", testSiteKey: false });
    expect(widget.log).toEqual(["mount:session", "token:session", "mount:compare"]);
    expect(widget.action).toBe("compare");
  });

  test("does not remount when the session widget is already showing", async () => {
    const widget = stubWidget("session");
    const token = await tokenForSessionMint(widget, { siteKey: "0x4AAAAAAAreal", testSiteKey: false, dummy: "XXXX.DUMMY.TOKEN.XXXX" });
    expect(token).toBe("tok-session-1");
    expect(widget.log).toEqual(["token:session"]);
  });

  test("test site key uses the dummy token and skips the widget", async () => {
    const widget = stubWidget("compare");
    const token = await tokenForSessionMint(widget, { siteKey: "1x00000000000000000000AA", testSiteKey: true, dummy: "XXXX.DUMMY.TOKEN.XXXX" });
    expect(token).toBe("XXXX.DUMMY.TOKEN.XXXX");
    expect(widget.log).toEqual([]);
  });

  test("a second mint after a network change still requests a session token", async () => {
    const widget = stubWidget("session");
    await tokenForSessionMint(widget, { siteKey: "0xreal", testSiteKey: false, dummy: "d" });
    remountCompareAfterMint(widget, { siteKey: "0xreal", testSiteKey: false });
    expect(widget.action).toBe("compare");
    const again = await tokenForSessionMint(widget, { siteKey: "0xreal", testSiteKey: false, dummy: "d" });
    expect(again).toBe("tok-session-1");
    remountCompareAfterMint(widget, { siteKey: "0xreal", testSiteKey: false });
    expect(widget.log).toEqual(["token:session", "mount:compare", "mount:session", "token:session", "mount:compare"]);
  });
});

describe("fit whole chat body", () => {
  test("drops oldest turns until the JSON body fits requestBytes", () => {
    const key = `sk-${"k".repeat(2400)}`;
    const system = "漢".repeat(2000);
    const messages = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "漢".repeat(800),
    }));
    const fitted = dropOldestUntilFits(
      { apiKey: key, baseUrl: "https://api.openai.com/v1", model: "m", system, temperature: 0.4, max_tokens: 256, messages },
      LIMITS.requestBytes,
    );
    expect(utf8ByteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(LIMITS.requestBytes);
    expect(fitted.messages.length).toBeGreaterThan(0);
    expect(fitted.messages.length).toBeLessThan(messages.length);
  });
});
