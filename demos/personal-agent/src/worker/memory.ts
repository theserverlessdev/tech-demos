import type { RecallHit } from "../shared/types";

const STOP = new Set(
  "the a an and or of to in on at for is are was be my me i you your it this that what do does did with how why who from about into".split(
    " ",
  ),
);

export const MIN_SEMANTIC = 0.58;
export const RECALL_BAND = 0.1;
export const MIN_LEXICAL_HITS = 2;
export const RECALL_K = 3;

/** Distinctive words for the keyword fallback. Embeddings are preferred when Workers AI answers. */
export function keywords(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].filter((word) => !STOP.has(word)).slice(0, 12);
}

export function keywordOverlap(query: string, stored: string): { hits: number; score: number } {
  const wanted = keywords(query);
  if (!wanted.length) return { hits: 0, score: 0 };
  const have = new Set(keywords(stored));
  let hits = 0;
  for (const word of wanted) if (have.has(word)) hits++;
  return { hits, score: hits / wanted.length };
}

export function keywordScore(query: string, stored: string): number {
  return keywordOverlap(query, stored).score;
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

export type ScoredNote = {
  id: string;
  title: string;
  semantic: number;
  lexicalHits: number;
  lexical: number;
};

export function noteScore(semantic: number, lexicalHits: number, lexical: number): number {
  return Math.max(semantic, lexicalHits >= MIN_LEXICAL_HITS ? lexical : 0);
}

export function keepNote(semantic: number, lexicalHits: number): boolean {
  return semantic >= MIN_SEMANTIC || lexicalHits >= MIN_LEXICAL_HITS;
}

export function selectRecalls(notes: ScoredNote[]): RecallHit[] {
  const hits = notes
    .filter((note) => keepNote(note.semantic, note.lexicalHits))
    .map((note) => ({
      id: note.id,
      title: note.title,
      score: Math.round(noteScore(note.semantic, note.lexicalHits, note.lexical) * 100) / 100,
    }))
    .sort((a, b) => b.score - a.score);
  const top = hits[0]?.score;
  if (top === undefined) return [];
  return hits.filter((hit) => hit.score >= top - RECALL_BAND).slice(0, RECALL_K);
}
