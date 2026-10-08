const encoder = new TextEncoder();

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Compare a presented secret to a stored SHA-256 hex digest. */
export async function matchesHash(given: string, expectedHex: string): Promise<boolean> {
  if (!given || !expectedHex) return false;
  const expected = hexToBytes(expectedHex);
  if (!expected) return false;
  const actual = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(given)));
  if (actual.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(actual, expected);
}

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(prefix === "org" ? 16 : 4));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}
