import { describe, expect, test } from "bun:test";
import {
  admitFrame,
  admitSay,
  admitScratch,
  ALLOWED_TURNSTILE_HOSTS,
  clipSpeakerName,
  contentLengthTooLarge,
  FRAME_MAX,
  hostAllowed,
  isReservedName,
  isTurnstileApi,
  livePeers,
  nextScratchWait,
  RECONNECT_MAX,
  SAYS_PER_MINUTE,
  SCRATCH_MIN_INTERVAL_MS,
  SCRATCH_SOCKET_MAX,
  shouldReconnect,
  TURNSTILE_RACE,
  TURNSTILE_UNLOCK,
  turnstileActionOk,
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

  test("rejects a missing or empty action", () => {
    expect(turnstileActionOk("race-arm", TURNSTILE_RACE)).toBe(true);
    expect(turnstileActionOk("chat-unlock", TURNSTILE_UNLOCK)).toBe(true);
    expect(turnstileActionOk(undefined, TURNSTILE_RACE)).toBe(false);
    expect(turnstileActionOk("", TURNSTILE_UNLOCK)).toBe(false);
    expect(turnstileActionOk("chat-unlock", TURNSTILE_RACE)).toBe(false);
  });
});

describe("admitScratch", () => {
  test("drops after 12 frames in 10s without treating that as a close", () => {
    let frames: number[] = [];
    const start = 2_000_000;
    for (let i = 0; i < SCRATCH_SOCKET_MAX; i++) {
      const next = admitScratch(frames, start + i);
      expect(next.ok).toBe(true);
      frames = next.frames;
    }
    const overflow = admitScratch(frames, start + SCRATCH_SOCKET_MAX);
    expect(overflow.ok).toBe(false);
    expect(overflow.frames.length).toBe(SCRATCH_SOCKET_MAX);
    const later = admitScratch(overflow.frames, start + 10_001);
    expect(later.ok).toBe(true);
  });
});

describe("nextScratchWait", () => {
  test("sends the first frame immediately, then waits about a second", () => {
    const now = 3_000_000;
    expect(nextScratchWait(0, now)).toBe(0);
    expect(nextScratchWait(now, now)).toBe(SCRATCH_MIN_INTERVAL_MS);
    expect(nextScratchWait(now - 400, now)).toBe(600);
    expect(nextScratchWait(now - SCRATCH_MIN_INTERVAL_MS, now)).toBe(0);
  });
});

describe("clipSpeakerName", () => {
  test("keeps Actor when the role is actor even if the stored name was Guest", () => {
    expect(clipSpeakerName("actor", "Guest")).toBe("Actor");
    expect(clipSpeakerName("actor", "Ada")).toBe("Actor");
    expect(clipSpeakerName("human", "Ada")).toBe("Ada");
    expect(clipSpeakerName("human", "Guest")).toBe("Guest");
  });
});

describe("shouldReconnect", () => {
  test("stops on 1001 or after RECONNECT_MAX attempts", () => {
    expect(shouldReconnect(1006, 0)).toBe(true);
    expect(shouldReconnect(1008, RECONNECT_MAX - 1)).toBe(true);
    expect(shouldReconnect(1008, RECONNECT_MAX)).toBe(false);
    expect(shouldReconnect(1001, 0)).toBe(false);
    expect(shouldReconnect(1001, 2)).toBe(false);
  });
});
