import { ROOM_ALPHABET, ROOM_ID, ROOM_ID_RAND_LEN, ROOM_ID_TAG_LEN } from "../shared/protocol";

const encoder = new TextEncoder();
/** Separate from the Turnstile secret so rotating the widget does not break live room links. */
const ROOM_ID_INFO = encoder.encode("tech-demos/partyserver/room-id");
const keyCache = new Map<string, CryptoKey>();

function encodeAlphabet(bytes: Uint8Array, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ROOM_ALPHABET[bytes[i]! % ROOM_ALPHABET.length];
  return out;
}

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i)! ^ b.charCodeAt(i)!;
  return diff === 0;
}

async function roomIdKey(secret: string): Promise<CryptoKey> {
  const cached = keyCache.get(secret);
  if (cached) return cached;
  const root = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", root, ROOM_ID_INFO);
  const key = await crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  keyCache.set(secret, key);
  return key;
}

async function tagFor(secret: string, rand: string): Promise<string> {
  const key = await roomIdKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(rand)));
  return encodeAlphabet(sig, ROOM_ID_TAG_LEN);
}

/** `rand10 + HMAC(room-id-key, rand10)` in the room alphabet. Verified before any Durable Object is touched. */
export async function mintRoomId(secret: string): Promise<string> {
  const rand = encodeAlphabet(crypto.getRandomValues(new Uint8Array(ROOM_ID_RAND_LEN)), ROOM_ID_RAND_LEN);
  return rand + (await tagFor(secret, rand));
}

export async function verifyRoomId(secret: string, id: string): Promise<boolean> {
  if (!secret || !ROOM_ID.test(id)) return false;
  const rand = id.slice(0, ROOM_ID_RAND_LEN);
  const tag = id.slice(ROOM_ID_RAND_LEN);
  return same(tag, await tagFor(secret, rand));
}
