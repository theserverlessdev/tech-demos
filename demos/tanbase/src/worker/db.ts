import {
  COLUMNS,
  LIMITS,
  type AttachmentMeta,
  type BoardMeta,
  type BoardSnapshot,
  type ColumnId,
  type Reminder,
  type SplitRun,
  type SplitStep,
  type Task,
} from "../shared/types";
import { HttpError } from "./errors";
import { newId } from "./validate";

type TaskRow = {
  id: string;
  column_name: string;
  title: string;
  description: string;
  due_at: number | null;
  position: number;
  parent_id: string | null;
  split_id: string | null;
  overdue: number;
  created_at: number;
  updated_at: number;
};

type AttachmentRow = {
  id: string;
  task_id: string;
  r2_key: string;
  filename: string;
  content_type: string;
  size: number;
  created_at: number;
};

type SplitRow = {
  id: string;
  task_id: string;
  instance_id: string;
  status: string;
  source: string;
  steps_json: string;
  error: string | null;
  created_at: number;
  updated_at: number;
};

function toTask(row: TaskRow): Task {
  const column: ColumnId = row.column_name === "doing" || row.column_name === "done" ? row.column_name : "todo";
  return {
    id: row.id,
    column,
    title: row.title,
    description: row.description,
    dueAt: row.due_at,
    position: row.position,
    parentId: row.parent_id,
    splitId: row.split_id,
    overdue: row.overdue === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseSteps(raw: string): SplitStep[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const steps: SplitStep[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const name = (item as { name?: unknown }).name;
      const at = (item as { at?: unknown }).at;
      if (typeof name === "string" && typeof at === "number") steps.push({ name, at });
    }
    return steps;
  } catch {
    return [];
  }
}

function toSplit(row: SplitRow): SplitRun {
  return {
    id: row.id,
    taskId: row.task_id,
    instanceId: row.instance_id,
    status: row.status,
    source: row.source,
    steps: parseSteps(row.steps_json),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function ensureVisitor(env: Env, visitorId: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO visitors (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING`).bind(visitorId, Date.now()).run();
}

export async function countBoards(env: Env, visitorId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM boards WHERE visitor_id = ?`).bind(visitorId).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listBoards(env: Env, visitorId: string): Promise<BoardMeta[]> {
  const rows = await env.DB.prepare(
    `SELECT id, title, created_at, expires_at FROM boards WHERE visitor_id = ? AND expires_at > ? ORDER BY created_at DESC`,
  )
    .bind(visitorId, Date.now())
    .all<{ id: string; title: string; created_at: number; expires_at: number }>();
  return rows.results.map((row) => ({ id: row.id, title: row.title, createdAt: row.created_at, expiresAt: row.expires_at }));
}

export async function createBoard(env: Env, visitorId: string, title: string, ttlMs: number): Promise<BoardMeta> {
  if ((await countBoards(env, visitorId)) >= LIMITS.maxBoardsPerVisitor) {
    throw new HttpError(429, "board_cap", `This browser already has ${LIMITS.maxBoardsPerVisitor} boards. Wait for one to expire.`);
  }
  const now = Date.now();
  const board: BoardMeta = { id: newId("b"), title, createdAt: now, expiresAt: now + ttlMs };
  await ensureVisitor(env, visitorId);
  await env.DB.prepare(`INSERT INTO boards (id, visitor_id, title, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`).bind(board.id, visitorId, board.title, board.createdAt, board.expiresAt).run();
  return board;
}

export async function getBoardForVisitor(env: Env, boardId: string, visitorId: string): Promise<BoardMeta | null> {
  const row = await env.DB.prepare(
    `SELECT id, title, created_at, expires_at FROM boards WHERE id = ? AND visitor_id = ? AND expires_at > ?`,
  )
    .bind(boardId, visitorId, Date.now())
    .first<{ id: string; title: string; created_at: number; expires_at: number }>();
  if (!row) return null;
  return { id: row.id, title: row.title, createdAt: row.created_at, expiresAt: row.expires_at };
}

export async function renameBoard(env: Env, boardId: string, title: string): Promise<void> {
  await env.DB.prepare(`UPDATE boards SET title = ? WHERE id = ?`).bind(title, boardId).run();
}

export async function loadSnapshot(env: Env, board: BoardMeta): Promise<BoardSnapshot> {
  const [tasks, attachments, reminders, splits] = await Promise.all([
    env.DB.prepare(`SELECT id, column_name, title, description, due_at, position, parent_id, split_id, overdue, created_at, updated_at FROM tasks WHERE board_id = ? ORDER BY position, created_at`).bind(board.id).all<TaskRow>(),
    env.DB.prepare(`SELECT id, task_id, filename, content_type, size, created_at FROM attachments WHERE board_id = ? ORDER BY created_at`).bind(board.id).all<Omit<AttachmentRow, "r2_key">>(),
    env.DB.prepare(`SELECT id, task_id, message, created_at FROM reminders WHERE board_id = ? ORDER BY created_at`).bind(board.id).all<{ id: string; task_id: string; message: string; created_at: number }>(),
    env.DB.prepare(`SELECT id, task_id, instance_id, status, source, steps_json, error, created_at, updated_at FROM splits WHERE board_id = ? ORDER BY created_at`).bind(board.id).all<SplitRow>(),
  ]);
  return {
    ...board,
    tasks: tasks.results.map(toTask),
    attachments: attachments.results.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      filename: row.filename,
      contentType: row.content_type,
      size: row.size,
      createdAt: row.created_at,
    })),
    reminders: reminders.results.map((row): Reminder => ({ id: row.id, taskId: row.task_id, message: row.message, createdAt: row.created_at })),
    splits: splits.results.map(toSplit),
  };
}

async function countTasks(env: Env, boardId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE board_id = ?`).bind(boardId).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function createTask(
  env: Env,
  boardId: string,
  input: { title: string; description: string; dueAt: number | null; column: ColumnId; parentId?: string | null; splitId?: string | null; id?: string },
): Promise<void> {
  if ((await countTasks(env, boardId)) >= LIMITS.maxTasksPerBoard) {
    throw new HttpError(429, "task_cap", `This board is capped at ${LIMITS.maxTasksPerBoard} cards.`);
  }
  const max = await env.DB.prepare(`SELECT COALESCE(MAX(position), -1) AS n FROM tasks WHERE board_id = ? AND column_name = ?`).bind(boardId, input.column).first<{ n: number }>();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO tasks (id, board_id, column_name, title, description, due_at, position, parent_id, split_id, overdue, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(input.id ?? newId("t"), boardId, input.column, input.title, input.description, input.dueAt, (max?.n ?? -1) + 1, input.parentId ?? null, input.splitId ?? null, now, now)
    .run();
}

export async function patchTask(
  env: Env,
  boardId: string,
  taskId: string,
  patch: { title?: string; description?: string; dueAt?: number | null; column?: ColumnId; index?: number },
): Promise<void> {
  const existing = await env.DB.prepare(`SELECT id, column_name, position FROM tasks WHERE id = ? AND board_id = ?`).bind(taskId, boardId).first<{ id: string; column_name: string; position: number }>();
  if (!existing) throw new HttpError(404, "not_found", "That card is gone.");

  const column = patch.column ?? (existing.column_name as ColumnId);
  const moving = patch.column !== undefined || patch.index !== undefined;
  if (moving) await placeTask(env, boardId, taskId, column, patch.index);

  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    values.push(patch.title);
  }
  if (patch.description !== undefined) {
    sets.push("description = ?");
    values.push(patch.description);
  }
  if (patch.dueAt !== undefined) {
    sets.push("due_at = ?");
    values.push(patch.dueAt);
    sets.push("overdue = 0");
  }
  if (sets.length) {
    sets.push("updated_at = ?");
    values.push(Date.now(), taskId, boardId);
    await env.DB.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND board_id = ?`).bind(...values).run();
  }
}

async function placeTask(env: Env, boardId: string, taskId: string, column: ColumnId, index: number | undefined): Promise<void> {
  const rows = await env.DB.prepare(`SELECT id, column_name FROM tasks WHERE board_id = ? ORDER BY position, created_at`).bind(boardId).all<{ id: string; column_name: string }>();
  const grouped = new Map<ColumnId, string[]>(COLUMNS.map((col) => [col, []]));
  for (const row of rows.results) {
    if (row.id === taskId) continue;
    const col: ColumnId = row.column_name === "doing" || row.column_name === "done" ? row.column_name : "todo";
    grouped.get(col)?.push(row.id);
  }
  const dest = grouped.get(column) ?? [];
  const at = index === undefined ? dest.length : Math.max(0, Math.min(index, dest.length));
  dest.splice(at, 0, taskId);
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (const col of COLUMNS) {
    grouped.get(col)?.forEach((id, position) => {
      statements.push(env.DB.prepare(`UPDATE tasks SET column_name = ?, position = ?, updated_at = ? WHERE id = ? AND board_id = ?`).bind(col, position, now, id, boardId));
    });
  }
  if (statements.length) await env.DB.batch(statements);
}

export async function deleteTask(env: Env, boardId: string, taskId: string): Promise<void> {
  const rows = await env.DB.prepare(`SELECT id FROM tasks WHERE board_id = ? AND (id = ? OR parent_id = ?)`).bind(boardId, taskId, taskId).all<{ id: string }>();
  if (!rows.results.some((row) => row.id === taskId)) throw new HttpError(404, "not_found", "That card is gone.");
  const ids = rows.results.map((row) => row.id);
  const keys = await attachmentKeysForTasks(env, boardId, ids);
  if (keys.length) await env.FILES.delete(keys);
  const marks = ids.map(() => "?").join(", ");
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM reminders WHERE board_id = ? AND task_id IN (${marks})`).bind(boardId, ...ids),
    env.DB.prepare(`DELETE FROM splits WHERE board_id = ? AND task_id IN (${marks})`).bind(boardId, ...ids),
    env.DB.prepare(`DELETE FROM attachments WHERE board_id = ? AND task_id IN (${marks})`).bind(boardId, ...ids),
    env.DB.prepare(`DELETE FROM tasks WHERE board_id = ? AND id IN (${marks})`).bind(boardId, ...ids),
  ]);
}

async function attachmentKeysForTasks(env: Env, boardId: string, taskIds: string[]): Promise<string[]> {
  if (!taskIds.length) return [];
  const marks = taskIds.map(() => "?").join(", ");
  const rows = await env.DB.prepare(`SELECT r2_key FROM attachments WHERE board_id = ? AND task_id IN (${marks})`).bind(boardId, ...taskIds).all<{ r2_key: string }>();
  return rows.results.map((row) => row.r2_key);
}

export async function insertAttachment(
  env: Env,
  boardId: string,
  taskId: string,
  file: { filename: string; contentType: string; size: number },
): Promise<{ id: string; r2Key: string }> {
  const task = await env.DB.prepare(`SELECT id FROM tasks WHERE id = ? AND board_id = ?`).bind(taskId, boardId).first();
  if (!task) throw new HttpError(404, "not_found", "That card is gone.");
  const perTask = await env.DB.prepare(`SELECT COUNT(*) AS n FROM attachments WHERE task_id = ?`).bind(taskId).first<{ n: number }>();
  const perBoard = await env.DB.prepare(`SELECT COUNT(*) AS n FROM attachments WHERE board_id = ?`).bind(boardId).first<{ n: number }>();
  if ((perTask?.n ?? 0) >= LIMITS.maxAttachmentsPerTask) throw new HttpError(429, "attachment_cap", "This card has enough files.");
  if ((perBoard?.n ?? 0) >= LIMITS.maxAttachmentsPerBoard) throw new HttpError(429, "attachment_cap", "This board has enough files.");
  const id = newId("a");
  const r2Key = `boards/${boardId}/${id}`;
  await env.DB.prepare(
    `INSERT INTO attachments (id, board_id, task_id, r2_key, filename, content_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, boardId, taskId, r2Key, file.filename, file.contentType, file.size, Date.now())
    .run();
  return { id, r2Key };
}

export async function removeAttachment(env: Env, boardId: string, attachmentId: string): Promise<void> {
  const row = await getAttachment(env, boardId, attachmentId);
  if (!row) throw new HttpError(404, "not_found", "That file is gone.");
  await env.FILES.delete(row.r2Key);
  await env.DB.prepare(`DELETE FROM attachments WHERE id = ? AND board_id = ?`).bind(attachmentId, boardId).run();
}

export async function getAttachment(env: Env, boardId: string, attachmentId: string): Promise<(AttachmentMeta & { r2Key: string }) | null> {
  const row = await env.DB.prepare(
    `SELECT id, task_id, r2_key, filename, content_type, size, created_at FROM attachments WHERE id = ? AND board_id = ?`,
  )
    .bind(attachmentId, boardId)
    .first<AttachmentRow>();
  if (!row) return null;
  return { id: row.id, taskId: row.task_id, r2Key: row.r2_key, filename: row.filename, contentType: row.content_type, size: row.size, createdAt: row.created_at };
}

export async function deleteBoardData(env: Env, boardId: string): Promise<number> {
  const rows = await env.DB.prepare(`SELECT r2_key FROM attachments WHERE board_id = ?`).bind(boardId).all<{ r2_key: string }>();
  const keys = rows.results.map((row) => row.r2_key);
  if (keys.length) await env.FILES.delete(keys);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM reminders WHERE board_id = ?`).bind(boardId),
    env.DB.prepare(`DELETE FROM splits WHERE board_id = ?`).bind(boardId),
    env.DB.prepare(`DELETE FROM attachments WHERE board_id = ?`).bind(boardId),
    env.DB.prepare(`DELETE FROM tasks WHERE board_id = ?`).bind(boardId),
    env.DB.prepare(`DELETE FROM boards WHERE id = ?`).bind(boardId),
  ]);
  return keys.length;
}

export async function createSplitRow(env: Env, boardId: string, taskId: string): Promise<SplitRun> {
  const task = await env.DB.prepare(`SELECT id FROM tasks WHERE id = ? AND board_id = ? AND parent_id IS NULL`).bind(taskId, boardId).first();
  if (!task) throw new HttpError(404, "not_found", "That card is gone.");
  const active = await env.DB.prepare(`SELECT id FROM splits WHERE task_id = ? AND status IN ('queued', 'running')`).bind(taskId).first();
  if (active) throw new HttpError(409, "split_running", "A split is already running for this card.");
  const children = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?`).bind(taskId).first<{ n: number }>();
  if ((children?.n ?? 0) > 0) throw new HttpError(409, "already_split", "This card already has subtasks.");
  if (LIMITS.maxTasksPerBoard - (await countTasks(env, boardId)) < 3) {
    throw new HttpError(429, "task_cap", "Not enough room on this board for subtasks.");
  }
  const now = Date.now();
  const id = newId("s");
  await env.DB.prepare(
    `INSERT INTO splits (id, board_id, task_id, instance_id, status, source, steps_json, error, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 'pending', '[]', NULL, ?, ?)`,
  )
    .bind(id, boardId, taskId, id, now, now)
    .run();
  return { id, taskId, instanceId: id, status: "queued", source: "pending", steps: [], error: null, createdAt: now, updatedAt: now };
}

export async function getSplit(env: Env, boardId: string, splitId: string): Promise<SplitRun | null> {
  const row = await env.DB.prepare(
    `SELECT id, task_id, instance_id, status, source, steps_json, error, created_at, updated_at FROM splits WHERE id = ? AND board_id = ?`,
  )
    .bind(splitId, boardId)
    .first<SplitRow>();
  return row ? toSplit(row) : null;
}

export async function updateSplit(
  env: Env,
  splitId: string,
  patch: { status?: string; source?: string; steps?: SplitStep[]; error?: string | null },
): Promise<void> {
  const current = await env.DB.prepare(`SELECT status, source, steps_json, error FROM splits WHERE id = ?`).bind(splitId).first<{ status: string; source: string; steps_json: string; error: string | null }>();
  if (!current) return;
  await env.DB.prepare(`UPDATE splits SET status = ?, source = ?, steps_json = ?, error = ?, updated_at = ? WHERE id = ?`)
    .bind(
      patch.status ?? current.status,
      patch.source ?? current.source,
      JSON.stringify(patch.steps ?? parseSteps(current.steps_json)),
      patch.error === undefined ? current.error : patch.error,
      Date.now(),
      splitId,
    )
    .run();
}

export type SubtaskDraft = { title: string; description: string };

export async function writeSubtasks(env: Env, boardId: string, parentId: string, splitId: string, drafts: SubtaskDraft[]): Promise<number> {
  const max = await env.DB.prepare(`SELECT COALESCE(MAX(position), -1) AS n FROM tasks WHERE board_id = ? AND column_name = 'todo'`).bind(boardId).first<{ n: number }>();
  const room = LIMITS.maxTasksPerBoard - (await countTasks(env, boardId));
  const slice = drafts.slice(0, Math.min(6, room));
  const now = Date.now();
  const start = (max?.n ?? -1) + 1;
  const statements = slice.map((draft, index) => {
    const id = `t_${splitId.slice(2)}_${index}`;
    return env.DB.prepare(
      `INSERT INTO tasks (id, board_id, column_name, title, description, due_at, position, parent_id, split_id, overdue, created_at, updated_at)
       VALUES (?, ?, 'todo', ?, ?, NULL, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(id, boardId, draft.title.slice(0, LIMITS.maxTitle), draft.description.slice(0, LIMITS.maxDescription), start + index, parentId, splitId, now, now);
  });
  if (statements.length) await env.DB.batch(statements);
  return slice.length;
}

const REMINDER = "Due date passed. Reminder logged only; no email is sent.";

export async function markOverdue(env: Env, now: number): Promise<string[]> {
  const due = await env.DB.prepare(
    `SELECT id, board_id FROM tasks WHERE due_at IS NOT NULL AND due_at < ? AND column_name != 'done' AND overdue = 0`,
  )
    .bind(now)
    .all<{ id: string; board_id: string }>();
  const boards = new Set<string>();
  for (const task of due.results) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE tasks SET overdue = 1, updated_at = ? WHERE id = ? AND overdue = 0`).bind(now, task.id),
      env.DB.prepare(`INSERT OR IGNORE INTO reminders (id, board_id, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`).bind(newId("r"), task.board_id, task.id, REMINDER, now),
    ]);
    boards.add(task.board_id);
  }
  return [...boards];
}

export async function listExpiredBoardIds(env: Env, now: number): Promise<string[]> {
  const rows = await env.DB.prepare(`SELECT id FROM boards WHERE expires_at <= ?`).bind(now).all<{ id: string }>();
  return rows.results.map((row) => row.id);
}
