const STOP = new Set(
  "the a an and or of to in on at for is are was be my me i you your it this that what do does did with how why who from about into".split(" "),
);

/** Distinctive words for the keyword fallback. Embeddings are preferred when Workers AI answers. */
export function keywords(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].filter((word) => !STOP.has(word)).slice(0, 12);
}

export function keywordScore(query: string, stored: string): number {
  const wanted = keywords(query);
  if (!wanted.length) return 0;
  const have = new Set(keywords(stored));
  let hit = 0;
  for (const word of wanted) if (have.has(word)) hit++;
  return hit / wanted.length;
}

export function normalize(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) / norm;
  return vector;
}

/** Both vectors are unit length, so the dot product is cosine similarity. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

export function toBlob(vector: Float32Array): ArrayBuffer {
  return vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength) as ArrayBuffer;
}

export function fromBlob(blob: ArrayBuffer | Uint8Array): Float32Array {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}
