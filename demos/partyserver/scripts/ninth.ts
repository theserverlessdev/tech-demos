// Probe: 8 OPEN sockets, then a 9th that sends a Yjs update as soon as it opens.
// bun run scripts/ninth.ts [baseUrl]
import YProvider from "y-partyserver/provider";
import * as Y from "yjs";
import { CLOSE_FULL, MAX_CONNECTIONS, PARTY, ROOM_ID, type CreatedRoom } from "../src/shared/protocol";

const DUMMY = "XXXX.DUMMY.TOKEN.XXXX";

function varUint(n: number): Uint8Array {
  const bytes: number[] = [];
  let value = n;
  while (value > 127) {
    bytes.push((value & 127) | 128);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** y-protocols sync frame: messageSync + messageYjsUpdate + length-prefixed update. */
export function yjsStrokeFrame(id: string, points: number[]): Uint8Array {
  const doc = new Y.Doc();
  doc.getMap("strokes").set(
    id,
    JSON.stringify({ id, color: "#c2410c", size: 6, points, client: "smokecli" }),
  );
  const update = Y.encodeStateAsUpdate(doc);
  return concatBytes(varUint(0), varUint(2), varUint(update.byteLength), update);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await sleep(50);
  }
  return false;
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error(`open timeout ${url}`)), 5000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`open error ${url}`));
    });
  });
}

export async function probeNinth(base: string): Promise<{ closeCode: number; landed: boolean; roomId: string }> {
  const created = await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turnstileToken: DUMMY }),
  });
  const room = (await created.json()) as CreatedRoom;
  if (created.status !== 201 || !ROOM_ID.test(room.id)) {
    throw new Error(`could not create room for ninth probe: ${created.status}`);
  }

  const host = base.replace(/^https?:\/\//, "");
  const watchDoc = new Y.Doc();
  const watch = new YProvider(host, room.id, watchDoc, { party: PARTY, disableBc: true });
  if (!(await waitFor(() => watch.wsconnected, 8000))) {
    watch.disconnect();
    throw new Error("ninth probe observer never connected");
  }

  const sockets: WebSocket[] = [];
  try {
    for (let i = 0; i < MAX_CONNECTIONS - 1; i++) {
      sockets.push(await openSocket(`${base.replace(/^http/, "ws")}/parties/board-room/${room.id}?_pk=ninth${i}`));
    }

    const payload = yjsStrokeFrame("ninthxxx", [10, 10, 40, 40]);
    const ninthUrl = `${base.replace(/^http/, "ws")}/parties/board-room/${room.id}?_pk=ninthwrite`;
    const closeCode = await new Promise<number>((resolve) => {
      const ws = new WebSocket(ninthUrl);
      const timer = setTimeout(() => resolve(0), 5000);
      ws.addEventListener("open", () => {
        ws.send(payload);
      });
      ws.addEventListener("close", (event) => {
        clearTimeout(timer);
        resolve(event.code);
      });
    });

    await sleep(800);
    const landed = watchDoc.getMap("strokes").has("ninthxxx");
    return { closeCode, landed, roomId: room.id };
  } finally {
    watch.disconnect();
    for (const socket of sockets) {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
  }
}

if (import.meta.main) {
  const base = (process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  console.log(`Target: ${base}`);
  const result = await probeNinth(base);
  const closeOk = result.closeCode === CLOSE_FULL;
  const writeOk = !result.landed;
  console.log(`${closeOk ? "PASS" : "FAIL"}  ninth connection is refused  → ${result.closeCode}`);
  console.log(`${writeOk ? "PASS" : "FAIL"}  ninth write did not land`);
  if (!closeOk || !writeOk) {
    console.error(`ninth probe failed for room ${result.roomId}`);
    process.exit(1);
  }
  console.log("ninth probe passed");
}
