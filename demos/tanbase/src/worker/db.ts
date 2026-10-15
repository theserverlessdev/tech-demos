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

function changed(result: D1Result): boolean {
  return (result.meta.changes ?? 0) > 0;
}

export async function countBoards(env: Env, visitorId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM boards WHERE visitor_id = ? AND expires_at > ?`).bind(visitorId, Date.now()).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countTables(env: Env): Promise<{ visitors: number; boards: number; tasks: number; orphanTasks: number; orphanChildren: number }> {
  const [visitors, boards, tasks, orphanTasks, orphanChildren] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM visitors`).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM boards`).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM tasks`).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE board_id NOT IN (SELECT id FROM boards)`).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM tasks)`).first<{ n: number }>(),
  ]);
  return {
    visitors: visitors?.n ?? 0,
    boards: boards?.n ?? 0,
    tasks: tasks?.n ?? 0,
    orphanTasks: orphanTasks?.n ?? 0,
    orphanChildren: orphanChildren?.n ?? 0,
  };
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
  const now = Date.now();
  const board: BoardMeta = { id: newId("b"), title, createdAt: now, expiresAt: now + ttlMs };
  await ensureVisitor(env, visitorId);
  const inserted = await env.DB.prepare(
    `INSERT INTO boards (id, visitor_id, title, created_at, expires_at)
     SELECT ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM boards WHERE visitor_id = ? AND expires_at > ?) < ?`,
  )
    .bind(board.id, visitorId, board.title, board.createdAt, board.expiresAt, visitorId, now, LIMITS.maxBoardsPerVisitor)
    .run();
  if (!changed(inserted)) {
    throw new HttpError(429, "board_cap", `This browser already has ${LIMITS.maxBoardsPerVisitor} boards. Wait for one to expire.`);
  }
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

export async function createTask(
  env: Env,
  boardId: string,
  input: { title: string; description: string; dueAt: number | null; column: ColumnId; parentId?: string | null; splitId?: string | null; id?: string },
): Promise<void> {
  const now = Date.now();
  const id = input.id ?? newId("t");
  const inserted = await env.DB.prepare(
    `INSERT INTO tasks (id, board_id, column_name, title, description, due_at, position, parent_id, split_id, overdue, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(position) FROM tasks WHERE board_id = ? AND column_name = ?), -1) + 1, ?, ?, 0, ?, ?
     WHERE (SELECT COUNT(*) FROM tasks WHERE board_id = ?) < ?
       AND EXISTS (SELECT 1 FROM boards WHERE id = ?)`,
  )
    .bind(
      id,
      boardId,
      input.column,
      input.title,
      input.description,
      input.dueAt,
      boardId,
      input.column,
      input.parentId ?? null,
      input.splitId ?? null,
      now,
      now,
      boardId,
      LIMITS.maxTasksPerBoard,
      boardId,
    )
    .run();
  if (!changed(inserted)) {
    const board = await env.DB.prepare(`SELECT id FROM boards WHERE id = ?`).bind(boardId).first();
    if (!board) throw new HttpError(404, "not_found", "That board is gone.");
    throw new HttpError(429, "task_cap", `This board is capped at ${LIMITS.maxTasksPerBoard} cards.`);
  }
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
    await env.DB.prepare(`DELETE FROM reminders WHERE board_id = ? AND task_id = ?`).bind(boardId, taskId).run();
  }
  if (patch.column === "done") sets.push("overdue = 0");
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
  const marks = ids.map(() => "?").join(", ");
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM reminders WHERE board_id = ? AND task_id IN (${marks})`).bind(boardId, ...ids),
    env.DB.prepare(`DELETE FROM splits WHERE board_id = ? AND task_id IN (${marks})`).bind(boardId, ...ids),
    env.DB.prepare(`DELETE FROM attachments WHERE board_id = ? AND task_id IN (${marks})`).bind(boardId, ...ids),
    env.DB.prepare(`DELETE FROM tasks WHERE board_id = ? AND id IN (${marks})`).bind(boardId, ...ids),
  ]);
  if (keys.length) await env.FILES.delete(keys);
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
  const id = newId("a");
  const r2Key = `boards/${boardId}/${id}`;
  const inserted = await env.DB.prepare(
    `INSERT INTO attachments (id, board_id, task_id, r2_key, filename, content_type, size, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ? AND board_id = ?)
       AND (SELECT COUNT(*) FROM attachments WHERE task_id = ?) < ?
       AND (SELECT COUNT(*) FROM attachments WHERE board_id = ?) < ?`,
  )
    .bind(
      id,
      boardId,
      taskId,
      r2Key,
      file.filename,
      file.contentType,
      file.size,
      Date.now(),
      taskId,
      boardId,
      taskId,
      LIMITS.maxAttachmentsPerTask,
      boardId,
      LIMITS.maxAttachmentsPerBoard,
    )
    .run();
  if (!changed(inserted)) {
    const task = await env.DB.prepare(`SELECT id FROM tasks WHERE id = ? AND board_id = ?`).bind(taskId, boardId).first();
    if (!task) throw new HttpError(404, "not_found", "That card is gone.");
    throw new HttpError(429, "attachment_cap", "This card or board has enough files.");
  }
  return { id, r2Key };
}

export async function removeAttachment(env: Env, boardId: string, attachmentId: string): Promise<void> {
  const row = await getAttachment(env, boardId, attachmentId);
  if (!row) throw new HttpError(404, "not_found", "That file is gone.");
  await env.DB.prepare(`DELETE FROM attachments WHERE id = ? AND board_id = ?`).bind(attachmentId, boardId).run();
  await env.FILES.delete(row.r2Key);
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
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM reminders WHERE board_id = ?`).bind(boardId),
    env.DB.prepare(`DELETE FROM splits WHERE board_id = ?`).bind(boardId),
    env.DB.prepare(`DELETE FROM attachments WHERE board_id = ?`).bind(boardId),
    env.DB.prepare(`DELETE FROM tasks WHERE board_id = ?`).bind(boardId),
    env.DB.prepare(`DELETE FROM boards WHERE id = ?`).bind(boardId),
  ]);
  if (keys.length) await env.FILES.delete(keys);
  return keys.length;
}

export async function createSplitRow(env: Env, boardId: string, taskId: string): Promise<SplitRun> {
  const now = Date.now();
  const id = newId("s");
  const inserted = await env.DB.prepare(
    `INSERT INTO splits (id, board_id, task_id, instance_id, status, source, steps_json, error, created_at, updated_at)
     SELECT ?, ?, ?, ?, 'running', 'pending', '[]', NULL, ?, ?
     WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ? AND board_id = ? AND parent_id IS NULL)
       AND NOT EXISTS (SELECT 1 FROM splits WHERE task_id = ? AND status IN ('queued', 'running'))
       AND NOT EXISTS (SELECT 1 FROM tasks WHERE parent_id = ?)
       AND (SELECT COUNT(*) FROM tasks WHERE board_id = ?) <= ?`,
  )
    .bind(id, boardId, taskId, id, now, now, taskId, boardId, taskId, taskId, boardId, LIMITS.maxTasksPerBoard - 3)
    .run();
  if (!changed(inserted)) {
    const task = await env.DB.prepare(`SELECT id FROM tasks WHERE id = ? AND board_id = ? AND parent_id IS NULL`).bind(taskId, boardId).first();
    if (!task) throw new HttpError(404, "not_found", "That card is gone.");
    const active = await env.DB.prepare(`SELECT id FROM splits WHERE task_id = ? AND status IN ('queued', 'running')`).bind(taskId).first();
    if (active) throw new HttpError(409, "split_running", "A split is already running for this card.");
    const children = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?`).bind(taskId).first<{ n: number }>();
    if ((children?.n ?? 0) > 0) throw new HttpError(409, "already_split", "This card already has subtasks.");
    throw new HttpError(429, "task_cap", "Not enough room on this board for subtasks.");
  }
  return { id, taskId, instanceId: id, status: "running", source: "pending", steps: [], error: null, createdAt: now, updatedAt: now };
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
  await env.DB.prepare(
    `UPDATE splits SET status = ?, source = ?, steps_json = ?, error = ?, updated_at = ?
     WHERE id = ? AND status IN ('queued', 'running')`,
  )
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
  const now = Date.now();
  const slice = drafts.slice(0, 6);
  const statements = slice.map((draft, index) => {
    const id = `t_${splitId.slice(2)}_${index}`;
    return env.DB.prepare(
      `INSERT INTO tasks (id, board_id, column_name, title, description, due_at, position, parent_id, split_id, overdue, created_at, updated_at)
       SELECT ?, ?, 'todo', ?, ?, NULL, COALESCE((SELECT MAX(position) FROM tasks WHERE board_id = ? AND column_name = 'todo'), -1) + 1, ?, ?, 0, ?, ?
       WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ? AND board_id = ?)
         AND EXISTS (SELECT 1 FROM boards WHERE id = ?)
         AND (SELECT COUNT(*) FROM tasks WHERE board_id = ?) < ?
       ON CONFLICT(id) DO NOTHING`,
    ).bind(
      id,
      boardId,
      draft.title.slice(0, LIMITS.maxTitle),
      draft.description.slice(0, LIMITS.maxDescription),
      boardId,
      parentId,
      splitId,
      now,
      now,
      parentId,
      boardId,
      boardId,
      boardId,
      LIMITS.maxTasksPerBoard,
    );
  });
  if (!statements.length) return 0;
  const results = await env.DB.batch(statements);
  return results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
}

const REMINDER = "Due date passed. Reminder logged only; no email is sent.";

export async function markOverdue(env: Env, now: number): Promise<string[]> {
  const due = await env.DB.prepare(
    `UPDATE tasks SET overdue = 1, updated_at = ?
     WHERE id IN (
       SELECT id FROM tasks
       WHERE due_at IS NOT NULL AND due_at < ? AND column_name != 'done' AND overdue = 0
       LIMIT ?
     )
     RETURNING id, board_id`,
  )
    .bind(now, now, LIMITS.sweepBatch)
    .all<{ id: string; board_id: string }>();
  const boards = new Set<string>();
  const reminders = due.results.map((task) => {
    boards.add(task.board_id);
    return env.DB.prepare(`INSERT OR IGNORE INTO reminders (id, board_id, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`).bind(
      newId("r"),
      task.board_id,
      task.id,
      REMINDER,
      now,
    );
  });
  if (reminders.length) await env.DB.batch(reminders);
  return [...boards];
}

export async function listExpiredBoardIds(env: Env, now: number): Promise<string[]> {
  const rows = await env.DB.prepare(`SELECT id FROM boards WHERE expires_at <= ? LIMIT ?`).bind(now, LIMITS.sweepBatch).all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

async function deleteOrphans(env: Env, table: "tasks" | "attachments" | "splits" | "reminders"): Promise<number> {
  const result = await env.DB.prepare(
    `DELETE FROM ${table} WHERE rowid IN (
       SELECT rowid FROM ${table} WHERE board_id NOT IN (SELECT id FROM boards) LIMIT ?
     )`,
  )
    .bind(LIMITS.sweepBatch)
    .run();
  return result.meta.changes ?? 0;
}

export async function sweepOrphans(env: Env): Promise<number> {
  const leaked = await env.DB.prepare(
    `SELECT r2_key FROM attachments WHERE board_id NOT IN (SELECT id FROM boards) LIMIT ?`,
  )
    .bind(LIMITS.sweepBatch)
    .all<{ r2_key: string }>();
  const keys = leaked.results.map((row) => row.r2_key);
  if (keys.length) await env.FILES.delete(keys);
  const tasks = await deleteOrphans(env, "tasks");
  const attachments = await deleteOrphans(env, "attachments");
  const splits = await deleteOrphans(env, "splits");
  const reminders = await deleteOrphans(env, "reminders");
  return tasks + attachments + splits + reminders;
}

export async function sweepUnusedVisitors(env: Env): Promise<number> {
  const result = await env.DB.prepare(
    `DELETE FROM visitors WHERE id IN (
       SELECT id FROM visitors WHERE id NOT IN (SELECT visitor_id FROM boards) LIMIT ?
     )`,
  )
    .bind(LIMITS.sweepBatch)
    .run();
  return result.meta.changes ?? 0;
}
