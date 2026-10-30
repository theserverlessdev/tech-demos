import { expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

type Sock = {
  readyState: number;
  sent: string[];
  attachment: unknown;
  closed: { code: number; reason: string } | null;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  accept(): void;
};

const sockets: Sock[] = [];
let puts = 0;

function makeSock(): Sock {
  const sock: Sock = {
    readyState: WebSocket.OPEN,
    sent: [],
    attachment: null,
    closed: null,
    serializeAttachment(value) {
      this.attachment = value;
    },
    deserializeAttachment() {
      return this.attachment;
    },
    send(data) {
      this.sent.push(data);
    },
    close(code = 1000, reason = "") {
      this.closed = { code, reason };
      this.readyState = WebSocket.CLOSED;
    },
    accept() {},
  };
  return sock;
}

class FakePair {
  0: Sock;
  1: Sock;
  constructor() {
    this[0] = makeSock();
    this[1] = makeSock();
  }
}

(globalThis as unknown as { WebSocketPair: typeof FakePair }).WebSocketPair = FakePair;

const { PairRoom } = await import("./room");
const { CLOSE_BAD_FRAME, CLOSE_LIMIT } = await import("../shared/protocol");

const CREATOR = "abcdefghjkmn";
const GUEST = "pqrstuvwxyz2";
const SDP = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";

function ofType(sock: Sock, type: string): unknown[] {
  return sock.sent.map((line) => JSON.parse(line) as { type: string }).filter((msg) => msg.type === type);
}

function harness() {
  sockets.length = 0;
  puts = 0;
  const storage = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => {
        puts += 1;
        storage.set(key, value);
      },
      setAlarm: async () => undefined,
      deleteAll: async () => {
        storage.clear();
      },
    },
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
    getWebSockets: () => sockets.filter((sock) => sock.readyState === WebSocket.OPEN),
    acceptWebSocket: (ws: Sock) => {
      sockets.push(ws);
    },
  };
  const room = new PairRoom(ctx as never, {} as never);
  return room;
}

async function connect(room: InstanceType<typeof PairRoom>, cid: string): Promise<Sock> {
  const response = await room.fetch(
    new Request(`https://pairlane.tech-demos.theserverless.dev/ws/room?cid=${cid}`, {
      headers: { Upgrade: "websocket" },
    }),
  );
  expect(response.status).toBe(101);
  const sock = sockets.at(-1);
  if (!sock) throw new Error("missing socket");
  return sock;
}

async function both(room: InstanceType<typeof PairRoom>): Promise<{ offerer: Sock; answerer: Sock }> {
  await room.create({ creatorCid: CREATOR, now: Date.now() });
  const offerer = await connect(room, CREATOR);
  const answerer = await connect(room, GUEST);
  return { offerer, answerer };
}

function candidate(port: number): string {
  return JSON.stringify({
    type: "candidate",
    candidate: `candidate:1 1 udp 2122252543 203.0.113.8 ${port} typ host`,
    sdpMid: "0",
    sdpMLineIndex: 0,
  });
}

test("a flood closes the socket without a put per frame", async () => {
  const room = harness();
  const { offerer, answerer } = await both(room);
  const before = puts;
  for (let i = 0; i < 21; i++) await room.webSocketMessage(offerer as never, candidate(40_000 + i));
  expect(offerer.closed?.code).toBe(CLOSE_LIMIT);
  expect(puts - before).toBeLessThan(21);
  expect(ofType(answerer, "candidate")).toHaveLength(20);
  expect(ofType(offerer, "candidate")).toHaveLength(0);
});

test("five bad frames close with 4008 and do not call put", async () => {
  const room = harness();
  const { offerer } = await both(room);
  const before = puts;
  for (let i = 0; i < 4; i++) await room.webSocketMessage(offerer as never, "x");
  expect(offerer.closed).toBeNull();
  expect(puts).toBe(before);
  await room.webSocketMessage(offerer as never, "x");
  expect(offerer.closed?.code).toBe(CLOSE_LIMIT);
  expect(puts).toBe(before);
});

test("a binary frame closes with 4009 and does not call put", async () => {
  const room = harness();
  const { offerer } = await both(room);
  const before = puts;
  await room.webSocketMessage(offerer as never, new ArrayBuffer(8));
  expect(offerer.closed?.code).toBe(CLOSE_BAD_FRAME);
  expect(puts).toBe(before);
});

test("an offer is relayed only to the other peer", async () => {
  const room = harness();
  const { offerer, answerer } = await both(room);
  const offer = JSON.stringify({ type: "offer", sdp: SDP });
  await room.webSocketMessage(offerer as never, offer);
  await room.webSocketMessage(offerer as never, offer);
  expect(offerer.closed).toBeNull();
  expect(ofType(offerer, "offer")).toHaveLength(0);
  expect(ofType(answerer, "offer")).toHaveLength(2);
  await room.webSocketMessage(offerer as never, offer);
  expect(offerer.closed?.code).toBe(CLOSE_LIMIT);
  expect(ofType(answerer, "offer")).toHaveLength(2);
});

test("an oversized frame closes with 4008 and does not call put", async () => {
  const room = harness();
  const { offerer } = await both(room);
  const before = puts;
  await room.webSocketMessage(offerer as never, "x".repeat(20_000));
  expect(offerer.closed?.code).toBe(CLOSE_LIMIT);
  expect(puts).toBe(before);
});
