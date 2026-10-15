import { timingEqual } from "./secret";

const ORG_SHAPE = /^org_([0-9a-f]{16})([0-9a-f]{16})$/;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function tagHex(key: string, randomHex: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(randomHex)));
  return toHex(mac.subarray(0, 8));
}

/** `org_<16 hex random><16 hex HMAC tag>`. The Worker rejects a tag mismatch before touching the DO namespace. */
export async function mintOrgId(key: string): Promise<string> {
  if (!key) throw new Error("ORG_ID_KEY is missing");
  const random = toHex(crypto.getRandomValues(new Uint8Array(8)));
  return `org_${random}${await tagHex(key, random)}`;
}

export function orgIdShape(orgId: string): boolean {
  return ORG_SHAPE.test(orgId);
}

export async function orgIdValid(key: string, orgId: string): Promise<boolean> {
  if (!key) return false;
  const match = ORG_SHAPE.exec(orgId);
  if (!match?.[1] || !match[2]) return false;
  const expected = fromHex(await tagHex(key, match[1]));
  const presented = fromHex(match[2]);
  if (!expected || !presented || expected.byteLength !== presented.byteLength) return false;
  return timingEqual(expected, presented);
}
