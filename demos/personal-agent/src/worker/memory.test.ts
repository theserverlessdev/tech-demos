import { expect, test } from "bun:test";
import { MIN_SEMANTIC, keywordOverlap, selectRecalls } from "./memory";

test("hello does not recall unrelated notes below the semantic floor", () => {
  const hits = selectRecalls([
    { id: "1", title: "Parking", semantic: 0.43, lexicalHits: 0, lexical: 0 },
    { id: "2", title: "Book list", semantic: 0.48, lexicalHits: 0, lexical: 0 },
    { id: "3", title: "Dentist", semantic: 0.45, lexicalHits: 0, lexical: 0 },
  ]);
  expect(hits).toEqual([]);
});

test("a real dentist match stays and nearby unrelated notes drop", () => {
  const hits = selectRecalls([
    { id: "1", title: "Dentist", semantic: 0.76, lexicalHits: 2, lexical: 0.4 },
    { id: "2", title: "Parking", semantic: 0.38, lexicalHits: 0, lexical: 0 },
    { id: "3", title: "Book list", semantic: 0.36, lexicalHits: 0, lexical: 0 },
  ]);
  expect(hits.map((hit) => hit.title)).toEqual(["Dentist"]);
  expect(hits[0]!.score).toBeGreaterThanOrEqual(MIN_SEMANTIC);
});

test("two keyword hits keep a note when embeddings are down", () => {
  const hits = selectRecalls([
    { id: "1", title: "Color palette", semantic: 0, lexicalHits: 2, lexical: 0.5 },
    { id: "2", title: "Unrelated", semantic: 0, lexicalHits: 1, lexical: 0.25 },
  ]);
  expect(hits.map((hit) => hit.title)).toEqual(["Color palette"]);
});

test("selectRecalls keeps scores within 0.1 of the top hit", () => {
  const hits = selectRecalls([
    { id: "1", title: "A", semantic: 0.8, lexicalHits: 0, lexical: 0 },
    { id: "2", title: "B", semantic: 0.72, lexicalHits: 0, lexical: 0 },
    { id: "3", title: "C", semantic: 0.6, lexicalHits: 0, lexical: 0 },
  ]);
  expect(hits.map((hit) => hit.title)).toEqual(["A", "B"]);
});

test("keywordOverlap counts distinctive words", () => {
  expect(keywordOverlap("What color palette do I like?", "Color palette graphite ember").hits).toBeGreaterThanOrEqual(2);
});
