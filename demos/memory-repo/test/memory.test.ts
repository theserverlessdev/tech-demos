import { makeCommit, treeFromFiles } from "../src/worker/git";
import { applyMemoryWrites, seedFiles } from "../src/worker/memory-files";
import { escapeHtml, renderMarkdown } from "../src/shared/markdown";
import { extractFacts } from "../src/worker/extract";
import { check } from "./assert";

const decoder = new TextDecoder();

const first = applyMemoryWrites(seedFiles(), [{ path: "preferences.md", add: ["Prefers dark mode"] }], "2026-10-09");
check(first.changed, "a new preference is a commit");
check(first.files["preferences.md"].includes("Prefers dark mode [source: chat; added: 2026-10-09]"), first.files["preferences.md"]);
check(first.files["MEMORY.md"].includes("Prefers dark mode (preferences.md)"), "index lists the new fact");
check(first.message === "Remember: Prefers dark mode", first.message);

const { tree, objects } = await treeFromFiles(first.files);
const blob = objects.find((object) => object.type === "blob" && decoder.decode(object.data).includes("Prefers dark mode"));
check(blob, "the commit tree contains the preference blob");
const commit = await makeCommit({
  tree: tree.sha,
  parents: [],
  author: { name: "Memory Agent", email: "memory@memory-repo.invalid", timestamp: 1_760_000_000 },
  message: first.message,
});
check(commit.sha.length === 40, commit.sha);
check(decoder.decode(commit.data).includes("Remember: Prefers dark mode"), "commit message is in the object");

const again = applyMemoryWrites(first.files, [{ path: "preferences.md", add: ["Prefers dark mode"] }], "2026-10-09");
check(!again.changed, "the same fact does not commit again");

const two = applyMemoryWrites(
  seedFiles(),
  [
    { path: "people.md", add: ["Name is Ankur"] },
    { path: "projects.md", add: ["Works on Cloudflare demos"] },
  ],
  "2026-10-09",
);
check(two.changed && two.message === "Remember 2 facts", two.message);

const chips = extractFacts("I prefer dark mode and short answers. My name is Ankur and I work on Cloudflare demos.");
check(chips.some((write) => write.path === "preferences.md" && write.add.some((fact) => fact.includes("dark mode"))), JSON.stringify(chips));
check(chips.some((write) => write.path === "people.md"), "name lands in people.md");
check(chips.some((write) => write.path === "projects.md" && write.add.some((fact) => /cloudflare/i.test(fact))), "work lands in projects.md");

check(extractFacts("What should I do next?").length === 0, "questions are not memories");
check(extractFacts("You should know I hate meetings.").every((write) => write.path !== "projects.md"), "you-should is not a project fact");
const hate = extractFacts("You should know I hate meetings.");
check(hate.some((write) => write.path === "preferences.md" && write.add.some((fact) => /meetings/i.test(fact))), JSON.stringify(hate));

const overflow = applyMemoryWrites(
  (() => {
    let files = seedFiles();
    for (let i = 0; i < 40; i++) {
      files = applyMemoryWrites(files, [{ path: "projects.md", add: [`Project number ${i}`] }], "2026-10-14").files;
    }
    return files;
  })(),
  [{ path: "projects.md", add: ["Project number 40"] }],
  "2026-10-14",
);
check(overflow.changed && overflow.message.includes("evicted 1"), overflow.message);
check(!overflow.files["projects.md"].includes("Project number 0"), "the 41st bullet evicts the oldest");
check(overflow.files["projects.md"].includes("Project number 40"), "the newest fact is kept");

const html = renderMarkdown(`# Memory\n\n- [people](people.md)\n\n<script>alert(1)</script>\n`);
check(html.includes("&lt;script&gt;"), html);
check(!html.includes("<script>"), "markdown cannot inject a tag");
check(html.includes('href="#file-people.md"'), html);
check(escapeHtml(`"quoted"`) === "&quot;quoted&quot;", "quotes are escaped");

console.log("memory tests passed");
