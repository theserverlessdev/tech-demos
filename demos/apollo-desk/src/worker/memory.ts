import { metered, PRICES } from "./meter";

/** Upstream sends facts to Vectorize. This slice keeps each 384-dim vector as a BLOB in the desk's own SQLite. */
export async function embed(env: Env, texts: string[]): Promise<Float32Array[]> {
  const input = texts.map((t) => t.slice(0, 1000));
  const estimate = (input.join(" ").length / 3) * PRICES.embed;
  const out = await metered(
    env,
    estimate,
    () => env.AI.run(env.EMBED_MODEL, { text: input }),
    (o) => ((o as { usage?: { prompt_tokens?: number } }).usage?.prompt_tokens ?? 0) * PRICES.embed,
  );
  const data = (out as { data?: number[][] }).data ?? [];
  return data.map((row) => normalize(Float32Array.from(row)));
}

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

/** Both vectors are unit length, so the dot product is the cosine similarity. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += a[i]! * b[i]!;
  return s;
}

export function toBlob(v: Float32Array): ArrayBuffer {
  return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
}

export function fromBlob(blob: ArrayBuffer | Uint8Array): Float32Array {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

const STOP = new Set("the a an and or of to in on at for is are was my me i you your it this that what do does did with".split(" "));

/** Words for keyword recall. Upstream merges semantic recall with keyword recall in the same way. */
export function keywords(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].filter((w) => !STOP.has(w)).slice(0, 6);
}
