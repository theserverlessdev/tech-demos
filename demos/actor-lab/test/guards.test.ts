import { describe, expect, test } from "bun:test";
import {
  admitFrame,
  admitSay,
  ALLOWED_TURNSTILE_HOSTS,
  contentLengthTooLarge,
  FRAME_MAX,
  hostAllowed,
  isReservedName,
  isTurnstileApi,
  livePeers,
  SAYS_PER_MINUTE,
  TURNSTILE_RACE,
  TURNSTILE_UNLOCK,
} from "../src/shared/guards";

describe("hostAllowed", () => {
  test("accepts only exact production and loopback hosts", () => {
    expect(hostAllowed("tech-demos.theserverless.dev")).toBe(true);
    expect(hostAllowed("actor-lab.tech-demos.theserverless.dev")).toBe(true);
    expect(hostAllowed("localhost")).toBe(true);
    expect(hostAllowed("127.0.0.1")).toBe(true);
  });

  test("rejects workers.dev, example.com, and lookalikes", () => {
    expect(hostAllowed("example.com")).toBe(false);
    expect(hostAllowed("actor-lab.workers.dev")).toBe(false);
    expect(hostAllowed("tech-demos-actor-lab.workers.dev")).toBe(false);
    expect(hostAllowed("evil.theserverless.dev")).toBe(false);
    expect(ALLOWED_TURNSTILE_HOSTS.has("example.com")).toBe(false);
  });
});

describe("livePeers", () => {
  test("counts only OPEN sockets other than the closing one", () => {
    const open = { readyState: 1 };
    const closing = { readyState: 2 };
    const otherOpen = { readyState: 1 };
    expect(livePeers([open, closing, otherOpen], closing)).toBe(2);
    expect(livePeers([open, closing], closing)).toBe(1);
    expect(livePeers([closing], closing)).toBe(0);
    expect(livePeers([open, otherOpen])).toBe(2);
  });
});

describe("admitFrame", () => {
  test("closes after more than 20 frames in 10s", () => {
    let frames: number[] = [];
    const start = 1_000_000;
    for (let i = 0; i < FRAME_MAX; i++) {
      const next = admitFrame(frames, start + i);
      expect(next.ok).toBe(true);
      frames = next.frames;
    }
    const overflow = admitFrame(frames, start + FRAME_MAX);
    expect(overflow.ok).toBe(false);
    const later = admitFrame(overflow.frames, start + 10_001);
    expect(later.ok).toBe(true);
  });
});

describe("admitSay", () => {
  test("persists a 30-says-per-minute window", () => {
    let says: number[] = [];
    const start = 5_000_000;
    for (let i = 0; i < SAYS_PER_MINUTE; i++) {
      const next = admitSay(says, start + i);
      expect(next.ok).toBe(true);
      says = next.says;
    }
    expect(admitSay(says, start + 10).ok).toBe(false);
    expect(admitSay(says, start + 60_000).ok).toBe(true);
  });
});

describe("reserved names and body size", () => {
  test("reserves Actor", () => {
    expect(isReservedName("Actor")).toBe(true);
    expect(isReservedName("actor")).toBe(true);
    expect(isReservedName(" Ada ")).toBe(false);
  });

  test("rejects content-length before buffering", () => {
    const fat = new Request("https://example.test/api/rooms", {
      method: "POST",
      headers: { "content-length": "40000" },
      body: "{}",
    });
    expect(contentLengthTooLarge(fat)).toBe(true);
    const ok = new Request("https://example.test/api/rooms", {
      method: "POST",
      headers: { "content-length": "12" },
      body: "{}",
    });
    expect(contentLengthTooLarge(ok)).toBe(false);
  });
});

describe("Turnstile helpers", () => {
  test("uses a distinct action per flow", () => {
    expect(TURNSTILE_RACE).toBe("race-arm");
    expect(TURNSTILE_UNLOCK).toBe("chat-unlock");
    expect(TURNSTILE_RACE).not.toBe(TURNSTILE_UNLOCK);
  });

  test("waitTurnstile rejects a DOM id shadow", () => {
    expect(isTurnstileApi({ nodeType: 1, id: "turnstile" })).toBe(false);
    expect(isTurnstileApi({ render: () => "w" })).toBe(true);
    expect(isTurnstileApi(undefined)).toBe(false);
  });
});
