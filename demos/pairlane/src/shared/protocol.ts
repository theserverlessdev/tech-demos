/** Public path on the hub zone. The subdomain serves the same Worker at `/`. */
export const BASE_PATH = "/demos/pairlane";

export const DEMO_HOST = "pairlane.tech-demos.theserverless.dev";

/** Rooms close themselves after 10 minutes. */
export const ROOM_TTL_MS = 10 * 60 * 1000;

export const MAX_PEERS = 2;

/** Whole-demo room opens per UTC day. */
export const DAILY_CAP = 240;

/** Crockford-ish alphabet: no 0/o/1/i/l. */
export const ROOM_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export const ROOM_ID_LEN = 8;
export const CID_LEN = 12;

export const ROOM_ID = new RegExp(`^[${ROOM_ALPHABET}]{${ROOM_ID_LEN}}$`);
export const CID = new RegExp(`^[${ROOM_ALPHABET}]{${CID_LEN}}$`);

/** Signalling JSON only. A file chunk is orders of magnitude larger and is rejected. */
export const MAX_SIGNAL_BYTES = 16 * 1024;
export const MAX_SDP_CHARS = 12_000;
export const MAX_CANDIDATE_CHARS = 2_000;

/** Browser data-channel cap. The Worker never sees the file. */
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const CHUNK_SIZE = 16 * 1024;

export const CLOSE_EXPIRED = 4001;
export const CLOSE_FULL = 4002;
export const CLOSE_REPLACED = 4003;
export const CLOSE_BAD_FRAME = 4009;

export const STUN_URL = "stun:stun.cloudflare.com:3478";

export type Role = "offerer" | "answerer";

export type TapeKind = "join" | "leave" | "offer" | "answer" | "candidate" | "reject" | "expire";

export type TapeEvent = {
  n: number;
  at: number;
  kind: TapeKind;
  bytes: number;
  summary: string;
};

export type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export type PublicConfig = {
  siteKey: string | null;
  local: boolean;
  ttlMs: number;
  maxPeers: number;
  dailyCap: number;
  stun: string;
  turn: boolean;
};

export type CreatedRoom = {
  id: string;
  expiresAt: number;
  remaining: number;
};

export type RoomStatus = {
  id: string;
  expiresAt: number;
  peers: number;
  expired: boolean;
  full: boolean;
};

export type ApiError = { error: { code: string; message: string } };

export function randomId(len: number, bytes?: Uint8Array): string {
  const buf = bytes ?? crypto.getRandomValues(new Uint8Array(len));
  if (buf.length < len) throw new Error("short id bytes");
  let out = "";
  for (let i = 0; i < len; i++) out += ROOM_ALPHABET[buf[i]! % ROOM_ALPHABET.length];
  return out;
}

export function randomRoomId(bytes?: Uint8Array): string {
  return randomId(ROOM_ID_LEN, bytes);
}

export function isExpired(expiresAt: number, now: number): boolean {
  return now >= expiresAt;
}
