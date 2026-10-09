import { Database } from "bun:sqlite";
import type { FtsDb } from "../src/worker/fts";
import { ensureFts, ftsMatch, recall, replaceIndexedFiles } from "../src/worker/fts";
import { applyMemoryWrites, seedFiles } from "../src/worker/memory-files";
import { check } from "./assert";

check(ftsMatch("dark-mode!") === '"dark" OR "mode"', ftsMatch("dark-mode!") ?? "null");
check(ftsMatch("!!!") === null, "punctuation is not a query");

const sqlite = new Database(":memory:");
const db: FtsDb = {
  exec(sql, ...params) {
    sqlite.query(sql).run(...params);
  },
  all(sql, ...params) {
    return sqlite.query(sql).all(...params) as Record<string, unknown>[];
  },
};

ensureFts(db);
const written = applyMemoryWrites(
  seedFiles(),
  [
    { path: "preferences.md", add: ["Prefers jasmine tea in the afternoon"] },
    { path: "people.md", add: ["Name is Ankur"] },
  ],
  "2026-10-09",
);
check(written.changed, "fixture writes");
replaceIndexedFiles(db, written.files, 1);

const tea = recall(db, "jasmine tea", 5);
check(tea.some((hit) => hit.path === "preferences.md"), JSON.stringify(tea));
check(tea.every((hit) => typeof hit.snippet === "string" && hit.snippet.length > 0), "snippet is present");

const person = recall(db, "Ankur", 5);
check(person.some((hit) => hit.path === "people.md"), JSON.stringify(person));

const none = recall(db, "zzzzqq", 5);
check(none.length === 0, "unknown words recall nothing");

console.log("fts tests passed");
