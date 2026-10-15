import { parseDream } from "../src/worker/dream";
import { applyMemoryWrites, seedFiles } from "../src/worker/memory-files";
import { check } from "./assert";

const current = seedFiles();

const garbage = parseDream("not json at all", current);
check(!garbage.ok && garbage.reason.includes("nothing was committed"), garbage.ok ? "" : garbage.reason);

const fenced = parseDream(
  "```json\n" +
    JSON.stringify({
      message: "tidy the index",
      why: "The recent list was empty noise.",
      files: {
        ...current,
        "MEMORY.md": current["MEMORY.md"].replace("Nothing remembered yet.", "Still quiet, on purpose."),
      },
    }) +
    "\n```",
  current,
);
check(fenced.ok, fenced.ok ? "" : fenced.reason);
if (fenced.ok) {
  check(fenced.message.startsWith("dream:"), fenced.message);
  check(fenced.files["MEMORY.md"].includes("Still quiet"), "the consolidated file is kept");
  check(fenced.files["people.md"].includes("people.md") || fenced.files["MEMORY.md"].includes("people.md"), "topic link remains");
}

const same = parseDream(
  JSON.stringify({ message: "dream: no change", why: "Already tidy.", files: current }),
  current,
);
check(!same.ok && same.reason.includes("match the current"), same.ok ? "" : same.reason);

const extra = parseDream(
  JSON.stringify({
    message: "dream: nope",
    why: "bad path",
    files: { ...current, "secrets.md": "nope\n" },
  }),
  current,
);
check(!extra.ok && extra.reason.includes("nothing was committed"), extra.ok ? "" : extra.reason);

const dropped = parseDream(
  JSON.stringify({
    message: "dream: drop links",
    why: "bad index",
    files: { ...current, "MEMORY.md": "# Memory\n\nNo links here.\n" },
  }),
  current,
);
check(!dropped.ok && dropped.reason.includes("topic links"), dropped.ok ? "" : dropped.reason);

const remembered = applyMemoryWrites(current, [{ path: "people.md", add: ["Name is Ankur"] }], "2026-10-14");
check(remembered.changed, "fixture person");
const stars = parseDream(
  JSON.stringify({
    message: "dream: stars",
    why: "wrong list",
    files: { "people.md": "# People\n\n* Name is Ankur [source: chat; added: 2026-10-14]\n" },
  }),
  remembered.files,
);
check(!stars.ok && (stars.reason.includes("numbered lists") || stars.reason.includes("*")), stars.ok ? "" : stars.reason);

const lost = parseDream(
  JSON.stringify({
    message: "dream: drop ankur",
    why: "oops",
    files: { "people.md": "# People\n\n- Nothing here yet.\n" },
  }),
  remembered.files,
);
check(!lost.ok && lost.reason.includes("dropped"), lost.ok ? "" : lost.reason);

const partial = parseDream(
  JSON.stringify({
    message: "tidy people",
    why: "Keep the fact, rewrite the heading spacing.",
    files: {
      "people.md": remembered.files["people.md"].replace("# People", "# People"),
    },
  }),
  remembered.files,
);
check(!partial.ok && partial.reason.includes("match the current"), partial.ok ? "" : partial.reason);

const kept = parseDream(
  JSON.stringify({
    message: "tidy people",
    why: "Keep Ankur and note the role.",
    files: {
      "people.md": remembered.files["people.md"].replace(
        "Name is Ankur [source: chat; added: 2026-10-14]",
        "Name is Ankur [source: chat; added: 2026-10-14]\n- Builds Workers demos [source: dream; added: 2026-10-14]",
      ),
    },
  }),
  remembered.files,
);
check(kept.ok, kept.ok ? "ok" : kept.reason);
if (kept.ok) {
  check(kept.files["people.md"].includes("Name is Ankur"), "partial dream keeps the old bullet");
  check(kept.files["preferences.md"] === remembered.files["preferences.md"] || kept.files["preferences.md"].includes("Preferences"), "unchanged files stay");
}

const overlapping = applyMemoryWrites(
  seedFiles(),
  [
    { path: "preferences.md", add: ["Likes tea"] },
    { path: "preferences.md", add: ["Likes jasmine tea"] },
  ],
  "2026-10-14",
);
check(overlapping.changed, "two overlapping preference bullets");
const mergedTea = parseDream(
  JSON.stringify({
    message: "dream: merge tea",
    why: "Fold likes tea into likes jasmine tea.",
    files: {
      "preferences.md": "# Preferences\n\n- Likes jasmine tea [source: chat; added: 2026-10-14]\n",
    },
  }),
  overlapping.files,
);
check(mergedTea.ok, mergedTea.ok ? "ok" : mergedTea.reason);
if (mergedTea.ok) {
  check(mergedTea.files["preferences.md"].includes("jasmine"), "the richer bullet is kept");
  check(!mergedTea.files["preferences.md"].includes("- Likes tea "), "the absorbed bullet is gone");
  check(/merg/i.test(mergedTea.why), mergedTea.why);
}

const foldedName = parseDream(
  JSON.stringify({
    message: "dream: fold name",
    why: "Keep Ankur as the visitor name.",
    files: {
      "people.md": "# People\n\n- Visitor name is Ankur Singh [source: dream; added: 2026-10-14]\n",
    },
  }),
  remembered.files,
);
check(foldedName.ok, foldedName.ok ? "ok" : foldedName.reason);

const lostDistinct = parseDream(
  JSON.stringify({
    message: "dream: drop tea",
    why: "oops",
    files: {
      "preferences.md": "# Preferences\n\n- Prefers coffee [source: dream; added: 2026-10-14]\n",
    },
  }),
  overlapping.files,
);
check(!lostDistinct.ok && lostDistinct.reason.includes("dropped"), lostDistinct.ok ? "ok" : lostDistinct.reason);

console.log("dream tests passed");
