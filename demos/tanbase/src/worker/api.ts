import { LIMITS, type BoardSnapshot } from "../shared/types";
import { boardStub, notifyBoard } from "./board";
import { createBoard, createSplitRow, deleteBoardData, ensureVisitor, getAttachment, getBoardForVisitor, getSplit, listBoards, loadSnapshot, updateSplit } from "./db";
import { HttpError } from "./errors";
import { sweep } from "./sweep";
import { turnstileConfigured, verifyTurnstile } from "./turnstile";
import {
  assertSameOrigin,
  clientIp,
  enforceLimit,
  parseDescription,
  parseDue,
  parseTitle,
  parseTtlMs,
  readJson,
  safeFilename,
} from "./validate";

const COOKIE = "tb_vid";
const VISITOR_RE = /^v_[a-f0-9]{24}$/;
const ID_RE = /^[a-z]_[a-f0-9]{16}$/;

// Production var is "". `.dev.vars` sets "1". The generated type is the literal "".
function localHooksEnabled(flag: string): boolean {
  return flag === "1";
}

const ALLOWED_TYPES: Record<string, (bytes: Uint8Array) => boolean> = {
  "image/png": (bytes) => bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
  "image/jpeg": (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/gif": (bytes) => bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46,
  "image/webp": (bytes) =>
    bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50,
  "application/pdf": (bytes) => bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46,
  "text/plain": (bytes) => {
    const sample = bytes.subarray(0, Math.min(bytes.length, 1024));
    for (const byte of sample) if (byte === 0) return false;
    return true;
  },
};

function json(data: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("cache-control", "no-store");
  return Response.json(data, { status, headers });
}

function visitorFrom(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === COOKIE && VISITOR_RE.test(rest.join("="))) return rest.join("=");
  }
  return null;
}

function cookieHeader(request: Request, visitorId: string): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${visitorId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`;
}

async function visitor(request: Request, env: Env): Promise<{ id: string; cookie: string | null }> {
  const existing = visitorFrom(request);
  if (existing) return { id: existing, cookie: null };
  const id = `v_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  await ensureVisitor(env, id);
  return { id, cookie: cookieHeader(request, id) };
}

function withCookie(response: Response, cookie: string | null): Response {
  if (!cookie) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, headers, webSocket: response.webSocket });
}

async function requireBoard(env: Env, boardId: string, visitorId: string) {
  if (!ID_RE.test(boardId)) throw new HttpError(404, "not_found", "That board is gone.");
  const board = await getBoardForVisitor(env, boardId, visitorId);
  if (!board) throw new HttpError(404, "not_found", "That board is gone.");
  return board;
}

async function callBoard(env: Env, boardId: string, visitorId: string, body: unknown): Promise<{ snapshot: BoardSnapshot; attachment?: { id: string; r2Key: string } }> {
  const res = await boardStub(env, boardId).fetch("https://board.internal/mutate", {
    method: "POST",
    headers: { "content-type": "application/json", "x-board-id": boardId, "x-visitor-id": visitorId },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { snapshot?: BoardSnapshot; attachment?: { id: string; r2Key: string }; error?: { code: string; message: string } };
  if (!res.ok || !data.snapshot) throw new HttpError(res.status, data.error?.code ?? "board", data.error?.message ?? "The board rejected that update.");
  return { snapshot: data.snapshot, attachment: data.attachment };
}

function sniff(contentType: string, bytes: Uint8Array): string {
  const declared = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const check = ALLOWED_TYPES[declared];
  if (!check || !check(bytes)) throw new HttpError(415, "type", "Files must be PNG, JPEG, WEBP, GIF, PDF, or plain text.");
  return declared;
}

export async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  const method = request.method;

  if (path === "/api/health" && method === "GET") {
    return json({ ok: true, model: env.AI_MODEL, turnstile: turnstileConfigured(env), limits: LIMITS });
  }

  if (path === "/api/sweep" && method === "POST") {
    if (!localHooksEnabled(env.ALLOW_LOCAL_HOOKS)) throw new HttpError(404, "not_found", "Unknown API route.");
    return json(await sweep(env));
  }

  const who = await visitor(request, env);
  const finish = (data: unknown, status = 200) => withCookie(json(data, status), who.cookie);

  if (method !== "GET" && method !== "HEAD") assertSameOrigin(request);

  if (path === "/api/session" && method === "GET") {
    return finish({ visitorId: who.id, siteKey: env.TURNSTILE_SITE_KEY, limits: LIMITS, boards: await listBoards(env, who.id) });
  }

  if (path === "/api/boards" && method === "POST") {
    await enforceLimit(env.WRITE_LIMIT, clientIp(request));
    const body = await readJson(request);
    await verifyTurnstile(env, request, body.turnstileToken, "create-board");
    const title = parseTitle(body.title, true);
    if (!title) throw new HttpError(400, "invalid", "Title is required.");
    const board = await createBoard(env, who.id, title, parseTtlMs(localHooksEnabled(env.ALLOW_LOCAL_HOOKS), body.ttlSeconds));
    return finish({ board }, 201);
  }

  const match = path.match(/^\/api\/boards\/([^/]+)(.*)$/);
  if (!match) throw new HttpError(404, "not_found", "Unknown API route.");
  const boardId = decodeURIComponent(match[1] ?? "");
  const rest = match[2] ?? "";
  const board = await requireBoard(env, boardId, who.id);

  if (rest === "/live" && method === "GET") {
    const headers = new Headers(request.headers);
    headers.set("x-board-id", board.id);
    headers.set("x-visitor-id", who.id);
    headers.set("x-client-ip", clientIp(request));
    headers.delete("x-tanbase-internal");
    return boardStub(env, board.id).fetch(new Request(request, { headers }));
  }

  if (rest === "" && method === "GET") return finish(await loadSnapshot(env, board));

  if (rest === "" && method === "PATCH") {
    await enforceLimit(env.WRITE_LIMIT, clientIp(request));
    const body = await readJson(request);
    const title = parseTitle(body.title, true);
    const result = await callBoard(env, board.id, who.id, { op: "rename", title });
    return finish(result.snapshot);
  }

  if (rest === "" && method === "DELETE") {
    await enforceLimit(env.WRITE_LIMIT, clientIp(request));
    const removedObjects = await deleteBoardData(env, board.id);
    await notifyBoard(env, board.id, "expired");
    return finish({ deleted: true, removedObjects });
  }

  if (rest === "/tasks" && method === "POST") {
    await enforceLimit(env.WRITE_LIMIT, clientIp(request));
    const body = await readJson(request);
    const result = await callBoard(env, board.id, who.id, {
      op: "create",
      title: body.title,
      description: parseDescription(body.description),
      dueAt: parseDue(body.dueAt),
      column: body.column,
    });
    return finish(result.snapshot, 201);
  }

  const taskMatch = rest.match(/^\/tasks\/([^/]+)(.*)$/);
  if (taskMatch) {
    const taskId = decodeURIComponent(taskMatch[1] ?? "");
    const tail = taskMatch[2] ?? "";
    if (!ID_RE.test(taskId) && !/^t_[a-f0-9]{16}_\d+$/.test(taskId)) throw new HttpError(404, "not_found", "That card is gone.");

    if (tail === "" && method === "PATCH") {
      await enforceLimit(env.WRITE_LIMIT, clientIp(request));
      const body = await readJson(request);
      const result = await callBoard(env, board.id, who.id, {
        op: "patch",
        taskId,
        title: body.title,
        description: body.description,
        dueAt: body.dueAt,
        column: body.column,
        index: body.index,
      });
      return finish(result.snapshot);
    }

    if (tail === "" && method === "DELETE") {
      await enforceLimit(env.WRITE_LIMIT, clientIp(request));
      const result = await callBoard(env, board.id, who.id, { op: "delete", taskId });
      return finish(result.snapshot);
    }

    if (tail === "/attachments" && method === "POST") {
      await enforceLimit(env.UPLOAD_LIMIT, clientIp(request));
      return finish(await upload(request, env, board.id, taskId, who.id), 201);
    }

    if (tail === "/split" && method === "POST") {
      await enforceLimit(env.AI_LIMIT, clientIp(request));
      await enforceLimit(env.WRITE_LIMIT, clientIp(request));
      const body = await readJson(request);
      await verifyTurnstile(env, request, body.turnstileToken, "board-write");
      const split = await createSplitRow(env, board.id, taskId);
      try {
        await env.SPLIT_TASK.create({ id: split.id, params: { boardId: board.id, taskId, splitId: split.id } });
      } catch (err) {
        await updateSplit(env, split.id, { status: "errored", error: "The workflow did not start." });
        console.error(JSON.stringify({ event: "workflow_create_failed", error: String(err) }));
        throw new HttpError(503, "workflow", "The split workflow did not start. Try again.");
      }
      await updateSplit(env, split.id, { status: "running" });
      return finish({ split: { ...split, status: "running" } }, 202);
    }
  }

  const splitMatch = rest.match(/^\/splits\/([^/]+)$/);
  if (splitMatch && method === "GET") {
    const splitId = decodeURIComponent(splitMatch[1] ?? "");
    const split = await getSplit(env, board.id, splitId);
    if (!split) throw new HttpError(404, "not_found", "That split is gone.");
    let workflow: { status: string; error: string | null } = { status: split.status, error: split.error };
    try {
      const instance = await env.SPLIT_TASK.get(split.instanceId);
      const status = await instance.status();
      workflow = { status: status.status, error: status.error?.message ?? null };
      if ((status.status === "errored" || status.status === "terminated") && split.status !== "errored") {
        await updateSplit(env, split.id, { status: "errored", error: workflow.error });
        split.status = "errored";
        split.error = workflow.error;
      }
    } catch (err) {
      console.warn(JSON.stringify({ event: "workflow_status_failed", error: String(err) }));
    }
    return finish({ split, workflow });
  }

  const fileMatch = rest.match(/^\/attachments\/([^/]+)$/);
  if (fileMatch && method === "GET") {
    const attachment = await getAttachment(env, board.id, decodeURIComponent(fileMatch[1] ?? ""));
    if (!attachment) throw new HttpError(404, "not_found", "That file is gone.");
    const object = await env.FILES.get(attachment.r2Key);
    if (!object) throw new HttpError(404, "not_found", "That file is gone.");
    const headers = new Headers({
      "content-type": attachment.contentType,
      "cache-control": "private, max-age=60",
      "x-content-type-options": "nosniff",
      "content-disposition": `attachment; filename="${attachment.filename.replaceAll('"', "")}"`,
    });
    return withCookie(new Response(object.body, { headers }), who.cookie);
  }

  if (fileMatch && method === "DELETE") {
    await enforceLimit(env.WRITE_LIMIT, clientIp(request));
    const result = await callBoard(env, board.id, who.id, { op: "detach", attachmentId: decodeURIComponent(fileMatch[1] ?? "") });
    return finish(result.snapshot);
  }

  throw new HttpError(404, "not_found", "Unknown API route.");
}

async function upload(request: Request, env: Env, boardId: string, taskId: string, visitorId: string): Promise<BoardSnapshot> {
  const form = await request.formData();
  await verifyTurnstile(env, request, form.get("turnstileToken"), "board-write");
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "invalid", "Choose a file to upload.");
  if (file.size <= 0 || file.size > LIMITS.maxAttachmentBytes) {
    throw new HttpError(413, "too_large", "Files must be 256 KB or smaller.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentType = sniff(file.type || (file.name.toLowerCase().endsWith(".txt") ? "text/plain" : ""), bytes);
  const reserved = await callBoard(env, boardId, visitorId, {
    op: "attach",
    taskId,
    filename: safeFilename(file.name),
    contentType,
    size: bytes.byteLength,
  });
  const key = reserved.attachment?.r2Key;
  if (!key || !reserved.attachment) throw new HttpError(500, "internal", "The file record was not stored.");
  try {
    await env.FILES.put(key, bytes, { httpMetadata: { contentType } });
  } catch (err) {
    await callBoard(env, boardId, visitorId, { op: "detach", attachmentId: reserved.attachment.id }).catch(() => undefined);
    console.error(JSON.stringify({ event: "r2_put_failed", error: String(err) }));
    throw new HttpError(503, "storage", "The file could not be stored.");
  }
  await notifyBoard(env, boardId, "snapshot");
  const board = await getBoardForVisitor(env, boardId, visitorId);
  if (!board) throw new HttpError(404, "not_found", "That board is gone.");
  return loadSnapshot(env, board);
}
