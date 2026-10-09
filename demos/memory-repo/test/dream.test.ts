import { parseDream } from "../src/worker/dream";
import { seedFiles } from "../src/worker/memory-files";
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

console.log("dream tests passed");
