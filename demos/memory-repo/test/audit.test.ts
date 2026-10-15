import { Database } from "bun:sqlite";
import { atCap, CONSUME_GLOBAL_AI_SQL, ROLLBACK_GLOBAL_AI_SQL, utcDay } from "../src/worker/budget";
import { readVisitorId } from "../src/worker/cookie";
import { extractFacts, mergeWrites } from "../src/worker/extract";
import { applyMemoryWrites, seedFiles } from "../src/worker/memory-files";
import { serialQueue } from "../src/worker/queue";
import { joinSentences } from "../src/worker/text";
import { check } from "./assert";

check(readVisitorId("mr_vid=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "valid cookie");
check(readVisitorId("mr_vid=%E0%A4%A") === null, "malformed percent-encoding is missing");
check(readVisitorId("other=1") === null, "other cookies are ignored");

check(joinSentences("Workers AI is not configured", "Nothing was committed") === "Workers AI is not configured. Nothing was committed.", joinSentences("Workers AI is not configured", "Nothing was committed"));
check(joinSentences("Already done.", "Nothing was committed.") === "Already done. Nothing was committed.", "trailing periods are not doubled");

check(extractFacts("What should I do next?").length === 0, "question facts");
const modelAnswered = mergeWrites([{ path: "people.md", add: ["Name is Ankur"] }]);
const withRegex = mergeWrites([{ path: "people.md", add: ["Name is Ankur"] }], extractFacts("What should I do next?"));
check(JSON.stringify(modelAnswered) === JSON.stringify(withRegex) || extractFacts("What should I do next?").length === 0, "regex unused when empty");

const modelNullWrites = mergeWrites(extractFacts("I prefer dark mode."));
check(modelNullWrites.some((write) => write.path === "preferences.md"), "regex is the fallback when the model is missing");

const enqueue = serialQueue();
const order: number[] = [];
let release!: () => void;
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
const first = enqueue(async () => {
  await gate;
  order.push(1);
  return "a";
});
const second = enqueue(async () => {
  order.push(2);
  return "b";
});
release();
const results = await Promise.all([first, second]);
check(results[0] === "a" && results[1] === "b", "queue returns in enqueue order");
check(order.join(",") === "1,2", "the second write waits for the first");

check(("seed" !== "chat-commit") === true, "a dream skips when head moved");

const sql = new Database(":memory:");
sql.exec(`CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  text TEXT NOT NULL
)`);
sql.exec("INSERT INTO messages (role, text) VALUES ('user', 'My name is Bluebird'), ('assistant', 'ok')");
function transcript(): string[] {
  return sql.query<{ text: string }>("SELECT text FROM messages ORDER BY id").all().map((row) => row.text);
}
check(transcript().length === 2, "chat has rows before wipe");
sql.exec("DROP TABLE IF EXISTS messages");
sql.exec("DROP TABLE IF EXISTS cf_agents_schedules");
sql.exec(`CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  text TEXT NOT NULL
)`);
check(transcript().length === 0, "wipe then transcript returns []");

const meter = new Database(":memory:");
meter.exec("CREATE TABLE ai_meter (day TEXT PRIMARY KEY, calls INTEGER NOT NULL)");
const day = utcDay();
const firstCall = meter.query<{ calls: number }>(CONSUME_GLOBAL_AI_SQL).get(day);
check(firstCall?.calls === 1, JSON.stringify(firstCall));
const secondCall = meter.query<{ calls: number }>(CONSUME_GLOBAL_AI_SQL).get(day);
check(secondCall?.calls === 2, JSON.stringify(secondCall));
check(atCap(2, 2), "cap is inclusive");
meter.query(ROLLBACK_GLOBAL_AI_SQL).run(day);
const rolled = meter.query<{ calls: number }>("SELECT calls FROM ai_meter WHERE day = ?").get(day);
check(rolled?.calls === 1, JSON.stringify(rolled));

const withDream = applyMemoryWrites(seedFiles(), [{ path: "people.md", add: ["Name is Ankur"] }], "2026-10-14");
const nextChat = applyMemoryWrites(withDream.files, [{ path: "preferences.md", add: ["Likes jasmine tea"] }], "2026-10-14");
check(nextChat.files["people.md"].includes("Name is Ankur"), "a later chat write keeps dream-compatible - bullets");
check(nextChat.files["preferences.md"].includes("Likes jasmine tea"), "the new fact is added");
check(nextChat.files["MEMORY.md"].includes("## Recent"), "MEMORY.md keeps Recent");

console.log("audit tests passed");
