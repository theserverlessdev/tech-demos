// Smoke: bun run scripts/smoke.ts [baseUrl]
import type { BoardMeta, BoardSnapshot, ServerEvent, SessionPayload, SplitRun } from "../src/shared/types";

const base = (process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const wsBase = base.replace(/^http/, "ws");
const token = "XXXX.DUMMY.TOKEN.XXXX";
const origin = base;

let failures = 0;
let cookie = "";

function check(label: string, ok: unknown, detail?: unknown): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

function remember(res: Response): void {
  const lines = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const fallback = res.headers.get("set-cookie");
  for (const line of fallback ? [...lines, fallback] : lines) {
    const pair = line.split(";")[0] ?? "";
    if (pair.startsWith("tb_vid=")) cookie = pair;
  }
}

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown; form?: FormData; jar?: string; headers?: Record<string, string>; rawBody?: BodyInit } = {},
): Promise<{ status: number; data: T | null; text: string; headers: Headers }> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if ("jar" in init) {
    if (init.jar) headers.cookie = init.jar;
  } else if (cookie) {
    headers.cookie = cookie;
  }
  let body: BodyInit | undefined;
  if (init.rawBody !== undefined) body = init.rawBody;
  else if (init.form) body = init.form;
  else if (init.body !== undefined) {
    headers["content-type"] = headers["content-type"] ?? "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${base}${path}`, { method: init.method ?? "GET", headers, body });
  if (!("jar" in init)) remember(res);
  const text = await res.text();
  let data: T | null = null;
  try {
    data = JSON.parse(text) as T;
  } catch {
    data = null;
  }
  return { status: res.status, data, text, headers: res.headers };
}

function track(ws: WebSocket): { next: (ms?: number) => Promise<ServerEvent> } {
  const messages: ServerEvent[] = [];
  let pending: ((msg: ServerEvent) => void) | null = null;
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as ServerEvent;
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve(message);
    } else messages.push(message);
  });
  return {
    next: (ms = 5000) => {
      const queued = messages.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("websocket timeout")), ms);
        pending = (message) => {
          clearTimeout(timer);
          resolve(message);
        };
      });
    },
  };
}

async function nextOf<T extends ServerEvent["type"]>(
  queue: { next: (ms?: number) => Promise<ServerEvent> },
  type: T,
  ms = 5000,
): Promise<Extract<ServerEvent, { type: T }>> {
  for (;;) {
    const message = await queue.next(ms);
    if (message.type === type) return message as Extract<ServerEvent, { type: T }>;
  }
}

function nextSnapshot(queue: { next: (ms?: number) => Promise<ServerEvent> }, ms = 5000) {
  return nextOf(queue, "snapshot", ms);
}

function nextPeers(queue: { next: (ms?: number) => Promise<ServerEvent> }, ms = 5000) {
  return nextOf(queue, "peers", ms);
}

type Counts = { visitors: number; boards: number; tasks: number; orphanTasks: number; orphanChildren: number };

async function waitSplitStep(boardId: string, splitId: string, name: string, ms = 4000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const status = await call<{ split: SplitRun }>(`/api/boards/${boardId}/splits/${splitId}`);
    if (status.data?.split.steps.some((step) => step.name === name)) return true;
    await Bun.sleep(150);
  }
  return false;
}

console.log(`Target: ${base}`);

const health = await call<{ ok: boolean; turnstile: boolean; model: string }>("/api/health");
check("health is ok and Turnstile is configured", health.status === 200 && health.data?.ok === true && health.data.turnstile === true, health.data);

const beforeVisitors = await call<Counts>("/api/counts");
check("local counts hook is available", beforeVisitors.status === 200, beforeVisitors.status);

await Promise.all([
  ...Array.from({ length: 20 }, () => call("/api/session", { jar: "" })),
  ...Array.from({ length: 10 }, () => call("/api/boards/b_0000000000000000", { jar: "" })),
  ...Array.from({ length: 10 }, () => call("/api/nope", { method: "POST", jar: "", body: { title: "nope" } })),
]);
const afterFlood = await call<Counts>("/api/counts");
check(
  "cookie-less requests do not write visitor rows",
  afterFlood.status === 200 && afterFlood.data?.visitors === beforeVisitors.data?.visitors,
  { before: beforeVisitors.data?.visitors, after: afterFlood.data?.visitors },
);

const unknownPage = await call("/no/such/page");
check("unknown page is 404, not index.html", unknownPage.status === 404 && !unknownPage.text.includes("Tanbase"), unknownPage.status);

const session = await call<SessionPayload>("/api/session");
check("session sets a visitor cookie without requiring a board", session.status === 200 && cookie.startsWith("tb_vid="), { status: session.status, cookie });

const afterSession = await call<Counts>("/api/counts");
check(
  "session GET still does not insert a visitor",
  afterSession.data?.visitors === beforeVisitors.data?.visitors,
  { before: beforeVisitors.data?.visitors, after: afterSession.data?.visitors },
);

const blocked = await call("/api/boards", { method: "POST", body: { title: "No check" } });
check("create board without Turnstile is refused", blocked.status === 400, blocked.status);

const oversizedJson = await call("/api/boards", {
  method: "POST",
  headers: { "content-type": "application/json" },
  rawBody: JSON.stringify({ title: "too big", turnstileToken: token, pad: "a".repeat(33_000) }),
});
check("oversize JSON body is refused before parse", oversizedJson.status === 413, oversizedJson.status);

const created = await call<{ board: BoardMeta }>("/api/boards", { method: "POST", body: { title: "Launch checklist", turnstileToken: token }, headers: { "cf-turnstile-response": token } });
const boardId = created.data?.board.id ?? "";
check("create board with the test Turnstile token", created.status === 201 && boardId.startsWith("b_"), created.data);

const afterCreate = await call<Counts>("/api/counts");
check(
  "first board create writes exactly one new visitor row",
  (afterCreate.data?.visitors ?? 0) === (beforeVisitors.data?.visitors ?? 0) + 1,
  { before: beforeVisitors.data?.visitors, after: afterCreate.data?.visitors },
);

if (!boardId) {
  console.error("Cannot continue without a board.");
  process.exit(1);
}

const capBoard = await call<{ board: BoardMeta }>("/api/boards", { method: "POST", body: { title: "Cap probe", turnstileToken: token }, headers: { "cf-turnstile-response": token } });
const capBoardId = capBoard.data?.board.id ?? "";
check("cap-probe board is created", capBoard.status === 201 && capBoardId.startsWith("b_"), capBoard.status);
if (capBoardId) {
  const burst = await Promise.all(
    Array.from({ length: 45 }, (_, i) =>
      call<BoardSnapshot>(`/api/boards/${capBoardId}/tasks`, { method: "POST", body: { title: `Cap card ${i}`, column: "todo" } }),
    ),
  );
  const accepted = burst.filter((item) => item.status === 201).length;
  const refused = burst.filter((item) => item.status === 429).length;
  const capSnap = await call<BoardSnapshot>(`/api/boards/${capBoardId}`);
  const cards = capSnap.data?.tasks.length ?? 0;
  check("card cap holds under a parallel create burst", cards <= 40 && accepted <= 40 && refused >= 5, { cards, accepted, refused });
  const removed = await call(`/api/boards/${capBoardId}`, { method: "DELETE" });
  check("cap-probe board is deleted", removed.status === 200, removed.status);
}

const orphanBoard = await call<{ board: BoardMeta }>("/api/boards", { method: "POST", body: { title: "Orphan split", turnstileToken: token }, headers: { "cf-turnstile-response": token } });
const orphanBoardId = orphanBoard.data?.board.id ?? "";
check("orphan-split board is created", orphanBoard.status === 201 && Boolean(orphanBoardId), orphanBoard.status);
if (orphanBoardId) {
  const orphanTask = await call<BoardSnapshot>(`/api/boards/${orphanBoardId}/tasks`, { method: "POST", body: { title: "Delete me mid-split" } });
  const orphanCard = orphanTask.data?.tasks[0];
  const orphanSplit = await call<{ split: SplitRun }>(`/api/boards/${orphanBoardId}/tasks/${orphanCard?.id}/split`, {
    method: "POST",
    body: { turnstileToken: token },
    headers: { "cf-turnstile-response": token },
  });
  const orphanSplitId = orphanSplit.data?.split.id ?? "";
  check("orphan-split starts", orphanSplit.status === 202 && Boolean(orphanSplitId), orphanSplit.status);
  const reachedAi = orphanSplitId ? await waitSplitStep(orphanBoardId, orphanSplitId, "ask workers ai") : false;
  check("orphan-split reached the AI step before the delete", reachedAi, reachedAi);
  const deleted = await call(`/api/boards/${orphanBoardId}`, { method: "DELETE" });
  check("orphan-split board is deleted during the local write delay", deleted.status === 200, deleted.status);
  await Bun.sleep(5000);
  const afterOrphan = await call<Counts>("/api/counts");
  check(
    "deleting a board mid-split leaves no orphan tasks",
    (afterOrphan.data?.orphanTasks ?? 1) === 0 && (afterOrphan.data?.orphanChildren ?? 1) === 0,
    afterOrphan.data,
  );
}

const parentCard = await call<BoardSnapshot>(`/api/boards/${boardId}/tasks`, { method: "POST", body: { title: "Parent mid-split" } });
const parentId = parentCard.data?.tasks.find((item) => item.title === "Parent mid-split")?.id ?? "";
const parentSplit = await call<{ split: SplitRun }>(`/api/boards/${boardId}/tasks/${parentId}/split`, {
  method: "POST",
  body: { turnstileToken: token },
  headers: { "cf-turnstile-response": token },
});
const parentSplitId = parentSplit.data?.split.id ?? "";
check("parent-split starts", parentSplit.status === 202 && Boolean(parentSplitId), parentSplit.status);
const parentReachedAi = parentSplitId ? await waitSplitStep(boardId, parentSplitId, "ask workers ai") : false;
check("parent-split reached the AI step before the delete", parentReachedAi, parentReachedAi);
const parentGone = await call(`/api/boards/${boardId}/tasks/${parentId}`, { method: "DELETE" });
check("parent card is deleted during the local write delay", parentGone.status === 200, parentGone.status);
await Bun.sleep(5000);
const afterParent = await call<BoardSnapshot>(`/api/boards/${boardId}`);
const afterParentCounts = await call<Counts>("/api/counts");
const leftoverKids = afterParent.data?.tasks.filter((item) => item.parentId === parentId) ?? [];
check(
  "deleting the parent mid-split leaves no orphan children",
  leftoverKids.length === 0 && (afterParentCounts.data?.orphanChildren ?? 1) === 0,
  { leftover: leftoverKids.length, counts: afterParentCounts.data },
);

const boardBurst = await Promise.all(
  Array.from({ length: 8 }, (_, i) =>
    call<{ board: BoardMeta }>("/api/boards", { method: "POST", body: { title: `Burst ${i}`, turnstileToken: token }, headers: { "cf-turnstile-response": token } }),
  ),
);
const listed = await call<SessionPayload>("/api/session");
const liveBoards = listed.data?.boards ?? [];
check(
  "board cap holds under a parallel create burst",
  liveBoards.length === 3 && boardBurst.filter((item) => item.status === 201).length <= 2 && boardBurst.filter((item) => item.status === 429).length >= 6,
  { boards: liveBoards.length, created: boardBurst.filter((item) => item.status === 201).length, refused: boardBurst.filter((item) => item.status === 429).length },
);
for (const extra of liveBoards.filter((item) => item.id !== boardId)) {
  await call(`/api/boards/${extra.id}`, { method: "DELETE" });
}

const added = await call<BoardSnapshot>(`/api/boards/${boardId}/tasks`, { method: "POST", body: { title: "Write the launch note", description: "One page, no slogans.", column: "todo" } });
const task = added.data?.tasks.find((item) => item.title === "Write the launch note");
check("create a card in To do", added.status === 201 && task?.column === "todo", added.status);

function openSocket(ws: WebSocket, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error(label)));
  });
}

const left = new WebSocket(`${wsBase}/api/boards/${boardId}/live`, { headers: { cookie, Origin: origin } });
const leftQ = track(left);
await openSocket(left, "left socket");
const helloLeft = await nextSnapshot(leftQ);
check("first tab snapshot is 1 peer", helloLeft.type === "snapshot" && helloLeft.peers === 1, helloLeft.peers);

const right = new WebSocket(`${wsBase}/api/boards/${boardId}/live`, { headers: { cookie, Origin: origin } });
const rightQ = track(right);
await openSocket(right, "right socket");
const joinedLeft = await nextPeers(leftQ);
const helloRight = await nextSnapshot(rightQ);
check("both tabs receive the opening snapshot", helloLeft.type === "snapshot" && helloRight.type === "snapshot", { left: helloLeft.type, right: helloRight.type });
check("first tab receives peers 2 when the second tab joins", joinedLeft.peers === 2, joinedLeft);
check("second tab snapshot is 2 peers", helloRight.peers === 2, helloRight.peers);

const evilClosed = await new Promise<boolean>((resolve) => {
  const evil = new WebSocket(`${wsBase}/api/boards/${boardId}/live`, { headers: { cookie, Origin: "https://evil.example" } });
  const timer = setTimeout(() => {
    evil.close();
    resolve(false);
  }, 2000);
  evil.addEventListener("open", () => {
    clearTimeout(timer);
    evil.close();
    resolve(false);
  });
  evil.addEventListener("error", () => {
    clearTimeout(timer);
    resolve(true);
  });
  evil.addEventListener("close", () => {
    if (evil.readyState === WebSocket.OPEN) return;
    clearTimeout(timer);
    resolve(true);
  });
});
check("cross-origin live socket is refused", evilClosed, evilClosed);

const synced = await call<BoardSnapshot>(`/api/boards/${boardId}/tasks`, { method: "POST", body: { title: "Ship the slice", column: "todo" } });
const ship = synced.data?.tasks.find((item) => item.title === "Ship the slice");
const seenLeft = await nextSnapshot(leftQ);
const seenRight = await nextSnapshot(rightQ);
const bothSeeShip = seenLeft.board.tasks.some((item) => item.id === ship?.id) && seenRight.board.tasks.some((item) => item.id === ship?.id);
check("a second tab sees a card created on the first", Boolean(ship) && bothSeeShip, { ship: ship?.id, left: seenLeft.type, right: seenRight.type });

if (task) {
  const moved = await call<BoardSnapshot>(`/api/boards/${boardId}/tasks/${task.id}`, { method: "PATCH", body: { column: "doing", index: 0, description: "Draft, then cut it in half." } });
  check("drag-equivalent move lands in Doing", moved.data?.tasks.find((item) => item.id === task.id)?.column === "doing", moved.status);
  const past = Date.UTC(2020, 0, 1, 23, 59, 59);
  const dated = await call<BoardSnapshot>(`/api/boards/${boardId}/tasks/${task.id}`, { method: "PATCH", body: { dueAt: past } });
  check("a past due date is stored", dated.data?.tasks.find((item) => item.id === task.id)?.dueAt === past, dated.status);
}

const form = new FormData();
form.set("file", new File(["tanbase smoke attachment\n"], "note.txt", { type: "text/plain" }));
const uploaded = await call<BoardSnapshot>(`/api/boards/${boardId}/tasks/${task?.id}/attachments`, { method: "POST", form, headers: { "cf-turnstile-response": token } });
const file = uploaded.data?.attachments.find((item) => item.filename === "note.txt");
check("text attachment is stored", uploaded.status === 201 && Boolean(file), uploaded.status);
if (file) {
  const download = await fetch(`${base}/api/boards/${boardId}/attachments/${file.id}`, { headers: { cookie } });
  const body = await download.text();
  check("attachment round-trips from R2", download.ok && body.includes("tanbase smoke attachment"), { status: download.status });
}

const noToken = new FormData();
noToken.set("file", new File(["x"], "note.txt", { type: "text/plain" }));
const missingHeader = await call(`/api/boards/${boardId}/tasks/${task?.id}/attachments`, { method: "POST", form: noToken });
check("upload without Turnstile header is refused", missingHeader.status === 400, missingHeader.status);

const bad = new FormData();
bad.set("file", new File(["<svg xmlns='http://www.w3.org/2000/svg'/>"], "x.svg", { type: "image/svg+xml" }));
const rejected = await call(`/api/boards/${boardId}/tasks/${task?.id}/attachments`, { method: "POST", form: bad, headers: { "cf-turnstile-response": token } });
check("disallowed content type is refused", rejected.status === 415, rejected.status);

const bulky = new FormData();
bulky.set("file", new File([new Uint8Array(256 * 1024 + 1)], "big.txt", { type: "text/plain" }));
const tooBig = await call(`/api/boards/${boardId}/tasks/${task?.id}/attachments`, { method: "POST", form: bulky, headers: { "cf-turnstile-response": token } });
check("oversize attachment is refused", tooBig.status === 413, tooBig.status);

const hugeUpload = await call(`/api/boards/${boardId}/tasks/${task?.id}/attachments`, {
  method: "POST",
  headers: { "cf-turnstile-response": token, "content-type": "multipart/form-data; boundary=xxxx" },
  rawBody: `--xxxx\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n${"x".repeat(301 * 1024)}\r\n--xxxx--`,
});
check("oversize upload body is refused before form parse", hugeUpload.status === 413, hugeUpload.status);

const stranger = await call<BoardSnapshot>(`/api/boards/${boardId}`, { jar: "tb_vid=v_0123456789abcdef01234567" });
check("another visitor cannot read the board", stranger.status === 404, stranger.status);

let splitId = "";
if (task) {
  const split = await call<{ split: SplitRun }>(`/api/boards/${boardId}/tasks/${task.id}/split`, { method: "POST", body: { turnstileToken: token }, headers: { "cf-turnstile-response": token } });
  splitId = split.data?.split.id ?? "";
  check("split starts a workflow", split.status === 202 && splitId.startsWith("s_"), { status: split.status, id: splitId });
}

let splitDone = false;
let splitSource = "";
if (splitId) {
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(500);
    const status = await call<{ split: SplitRun; workflow: { status: string } }>(`/api/boards/${boardId}/splits/${splitId}`);
    const names = status.data?.split.steps.map((step) => step.name) ?? [];
    if (status.data?.split.status === "complete" && names.includes("load task") && names.includes("ask workers ai") && names.includes("write subtasks")) {
      splitDone = true;
      splitSource = status.data.split.source;
      break;
    }
    if (status.data?.split.status === "errored" || status.data?.workflow.status === "errored") {
      console.log(`      split errored: ${status.data?.split.error ?? status.data?.workflow.status}`);
      break;
    }
  }
}
check("workflow steps complete and subtasks exist", splitDone, { source: splitSource });
if (splitDone) {
  const after = await call<BoardSnapshot>(`/api/boards/${boardId}`);
  const children = after.data?.tasks.filter((item) => item.parentId === task?.id) ?? [];
  check("split wrote 3–6 subtasks", children.length >= 3 && children.length <= 6, { count: children.length, source: splitSource });
  console.log(`      source=${splitSource}  subtasks=${children.length}`);
}

const short = await call<{ board: BoardMeta }>("/api/boards", { method: "POST", body: { title: "Expires soon", turnstileToken: token, ttlSeconds: 60 }, headers: { "cf-turnstile-response": token } });
const shortId = short.data?.board?.id ?? "";
check("local ttlSeconds creates a short-lived board", short.status === 201 && Boolean(shortId), short.status);
if (shortId) {
  const shortTask = await call<BoardSnapshot>(`/api/boards/${shortId}/tasks`, { method: "POST", body: { title: "Gone soon" } });
  const shortCard = shortTask.data?.tasks[0];
  const shortForm = new FormData();
  shortForm.set("file", new File(["delete me\n"], "gone.txt", { type: "text/plain" }));
  const shortFile = await call<BoardSnapshot>(`/api/boards/${shortId}/tasks/${shortCard?.id}/attachments`, { method: "POST", form: shortForm, headers: { "cf-turnstile-response": token } });
  check("short-lived board accepted a file", shortFile.status === 201, shortFile.status);
}

const third = await call<{ board: BoardMeta }>("/api/boards", { method: "POST", body: { title: "Third", turnstileToken: token }, headers: { "cf-turnstile-response": token } });
check("third board is allowed", third.status === 201, third.status);
const fourth = await call("/api/boards", { method: "POST", body: { title: "Fourth", turnstileToken: token }, headers: { "cf-turnstile-response": token } });
check("fourth board hits the visitor cap", fourth.status === 429, fourth.status);

if (short.data?.board.expiresAt) {
  const wait = short.data.board.expiresAt - Date.now() + 250;
  if (wait > 0) await Bun.sleep(wait);
}

const swept = await call<{ overdueBoards: number; expired: number; removedObjects: number; unusedVisitors: number }>("/api/sweep", { method: "POST" });
check(
  "sweep marks overdue work and deletes expired boards",
  (swept.data?.overdueBoards ?? 0) >= 1 && (swept.data?.expired ?? 0) >= 1 && (swept.data?.removedObjects ?? 0) >= 1,
  swept.data,
);

const expiredBoard = await call(`/api/boards/${shortId}`);
check("expired board is no longer readable", expiredBoard.status === 404, expiredBoard.status);
const reminded = await call<BoardSnapshot>(`/api/boards/${boardId}`);
const reminder = reminded.data?.reminders.find((item) => item.taskId === task?.id);
const overdue = reminded.data?.tasks.find((item) => item.id === task?.id)?.overdue === true;
check("overdue card has a reminder log and no email", Boolean(reminder) && overdue && reminder?.message.includes("no email"), reminder?.message);

const doneCard = await call<BoardSnapshot>(`/api/boards/${boardId}/tasks/${task?.id}`, { method: "PATCH", body: { column: "done" } });
check("moving an overdue card to Done clears the overdue flag", doneCard.data?.tasks.find((item) => item.id === task?.id)?.overdue === false, doneCard.status);

right.close();
const leftAlone = await nextPeers(leftQ);
check("first tab receives peers 1 after the second tab leaves", leftAlone.peers === 1, leftAlone);
left.close();

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
