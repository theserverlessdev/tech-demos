import { Database } from "bun:sqlite";
import { chatFailure, safeApiMessage } from "../src/worker/http-error";
import {
  atCap,
  CONSUME_GLOBAL_AI_SQL,
  DEFAULT_AI_CALLS_PER_DAY,
  DEFAULT_VISITOR_TURNS_PER_DAY,
  isMeterMissingError,
  METER_MISSING_MESSAGE,
  MeterMissingError,
  ROLLBACK_GLOBAL_AI_SQL,
  utcDay,
} from "../src/worker/budget";
import { readVisitorId } from "../src/worker/cookie";
import { consumeGlobalAiCall } from "../src/worker/db";
import { extractFacts, mergeWrites } from "../src/worker/extract";
import { DREAM_STALE_REASON, purgeChatAgent, staleDreamHead, wipeSession } from "../src/worker/lifecycle";
import { applyMemoryWrites, seedFiles } from "../src/worker/memory-files";
import { serialQueue } from "../src/worker/queue";
import { joinSentences } from "../src/worker/text";
import { check } from "./assert";
import type { DemoEnv } from "../src/worker/env";

check(readVisitorId("mr_vid=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "valid cookie");
check(readVisitorId("mr_vid=%E0%A4%A") === null, "malformed percent-encoding is missing");
check(readVisitorId("other=1") === null, "other cookies are ignored");

check(
  joinSentences("Workers AI is not configured", "Nothing was committed") === "Workers AI is not configured. Nothing was committed.",
  joinSentences("Workers AI is not configured", "Nothing was committed"),
);
check(joinSentences("Already done.", "Nothing was committed.") === "Already done. Nothing was committed.", "trailing periods are not doubled");

check(extractFacts("What should I do next?").length === 0, "question facts");
const modelAnswered = mergeWrites([{ path: "people.md", add: ["Name is Ankur"] }]);
const withRegex = mergeWrites([{ path: "people.md", add: ["Name is Ankur"] }], extractFacts("What should I do next?"));
check(JSON.stringify(modelAnswered) === JSON.stringify(withRegex), "regex unused when empty");

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

check(DEFAULT_VISITOR_TURNS_PER_DAY === 40, String(DEFAULT_VISITOR_TURNS_PER_DAY));
check(DEFAULT_VISITOR_TURNS_PER_DAY * 2 < DEFAULT_AI_CALLS_PER_DAY, "two visitors cannot exhaust the UTC day");

/** B1: wipeSession / purgeChatAgent are what MemoryAgent.wipe and ChatAgent.purge call. */
class FakeChat {
  rows = ["My name is Bluebird", "ok"];
  destroyed = false;
  async destroy(): Promise<void> {
    this.rows = [];
    this.destroyed = true;
  }
}

const chat = new FakeChat();
const wipeOrder: string[] = [];
let visitorGone = false;
await wipeSession({
  purgeChat: async () => {
    await purgeChatAgent(chat);
    wipeOrder.push("chat");
  },
  deleteRepo: async () => {
    wipeOrder.push("repo");
  },
  deleteVisitorRow: async () => {
    visitorGone = true;
    wipeOrder.push("visitor");
  },
  destroyMemory: async () => {
    wipeOrder.push("memory");
  },
});
check(chat.destroyed, "purgeChatAgent calls destroy()");
check(chat.rows.length === 0, "destroy() clears the transcript");
check(visitorGone, "the D1 visitor row is deleted");
check(wipeOrder.join(",") === "chat,repo,visitor,memory", wipeOrder.join(","));

/** B2: the dream records head, chat commits through serialQueue, then staleDreamHead skips. */
let head: string | null = "seed";
let files = seedFiles();
const writeQueue = serialQueue();
const headBefore = head;
const chatCommit = writeQueue(async () => {
  const next = applyMemoryWrites(files, [{ path: "people.md", add: ["Name is Jasmine"] }], "2026-10-14");
  check(next.changed, "the chat fact is a commit");
  files = next.files;
  head = "chat-commit";
  return next;
});
await chatCommit;
check(staleDreamHead(headBefore, head), "a chat commit during the model call moves head");
const dreamPush = writeQueue(async () => {
  if (staleDreamHead(headBefore, head)) return { skipped: true as const, reason: DREAM_STALE_REASON };
  head = "dream-commit";
  return { skipped: false as const, reason: "" };
});
const dreamResult = await dreamPush;
check(dreamResult.skipped && dreamResult.reason === DREAM_STALE_REASON, dreamResult.reason);
check(head === "chat-commit", "the dream does not overwrite the chat head");
check(files["people.md"].includes("Name is Jasmine"), "the in-flight chat fact is kept");

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

function fakeEnv(run: (sql: string) => Promise<unknown>): DemoEnv {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              first: () => run(sql),
              run: () => run(sql),
            };
          },
        };
      },
    },
  } as unknown as DemoEnv;
}

const missing = fakeEnv(async () => {
  throw new Error("D1_ERROR: no such table: ai_meter");
});
let meterErr: unknown;
try {
  await consumeGlobalAiCall(missing, day, 300);
} catch (err) {
  meterErr = err;
}
check(meterErr instanceof MeterMissingError, String(meterErr));
check(isMeterMissingError(meterErr), "no such table is a missing meter");
check((meterErr as Error).message === METER_MISSING_MESSAGE, (meterErr as Error).message);

const missingChat = chatFailure(new MeterMissingError());
check(missingChat.status === 503 && missingChat.code === "meter", JSON.stringify(missingChat));
check(missingChat.message === METER_MISSING_MESSAGE, missingChat.message);
check(safeApiMessage(new MeterMissingError(), "The chat turn failed.") === METER_MISSING_MESSAGE, "meter text is allowlisted");
check(chatFailure(new Error("This browser reached its daily AI limit (40 turns). Try tomorrow.")).status === 429, "visitor cap is 429");
check(chatFailure(new Error("Workers AI did not answer. Nothing was saved.")).status === 503, "model down is 503");
check(chatFailure(new Error("sqlite exploded")).status === 502, "unknown stays 502");
check(safeApiMessage(new Error("sqlite exploded"), "The chat turn failed.") === "The chat turn failed.", "unknown is not leaked");

const dreamed = {
  ...seedFiles(),
  "MEMORY.md": [
    "# Memory",
    "",
    "Dream summary: Ankur drinks jasmine tea.",
    "",
    "- [people](people.md) — names and roles",
    "- [preferences](preferences.md) — durable likes and dislikes",
    "- [projects](projects.md) — work in progress",
    "",
    "## Recent",
    "",
    "- 2026-10-14 Name is Ankur (people.md)",
    "",
  ].join("\n"),
  "people.md": "# People\n\n## Known\n\n- Name is Ankur [source: chat; added: 2026-10-14]\n",
};
const nextChat = applyMemoryWrites(dreamed, [{ path: "preferences.md", add: ["Likes jasmine tea"] }], "2026-10-14");
check(nextChat.files["people.md"].includes("Name is Ankur"), "a later chat write keeps dream-compatible - bullets");
check(nextChat.files["people.md"].includes("## Known"), "topic headings a dream added survive a chat write");
check(nextChat.files["MEMORY.md"].includes("Dream summary: Ankur drinks jasmine tea."), "MEMORY.md is not rebuilt from the template");
check(nextChat.files["MEMORY.md"].includes("Likes jasmine tea"), "the new fact is in Recent");
check(nextChat.files["preferences.md"].includes("Likes jasmine tea"), "the new fact is added");

console.log("audit tests passed");
