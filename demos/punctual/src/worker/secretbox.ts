import { sha256 } from "./sign";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const bin = atob(padded + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function tokenEncryptionSecret(env: { TOKEN_ENCRYPTION_KEY?: string; SIGNING_SECRET?: string; HOST_ID?: string }): {
  secret: string;
  mode: "dedicated" | "signing" | "dev-fallback";
} {
  const dedicated = env.TOKEN_ENCRYPTION_KEY?.trim();
  if (dedicated) return { secret: dedicated, mode: "dedicated" };
  const signing = env.SIGNING_SECRET?.trim();
  if (signing) return { secret: signing, mode: "signing" };
  return { secret: `punctual-dev-box:${env.HOST_ID || "ankur"}`, mode: "dev-fallback" };
}

async function aesKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", await sha256(secret), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(secret: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(secret);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext)));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return toBase64Url(packed);
}

export async function open(secret: string, blob: string): Promise<string> {
  const packed = fromBase64Url(blob);
  if (packed.length < 13) throw new Error("cipher too short");
  const iv = packed.slice(0, 12);
  const ct = packed.slice(12);
  const key = await aesKey(secret);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return decoder.decode(pt);
}
