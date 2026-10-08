import { DurableObject } from "cloudflare:workers";
import type { BoardSnapshot, ClientEvent, ColumnId } from "../shared/types";
import {
  createTask,
  deleteTask,
  getBoardForVisitor,
  insertAttachment,
  loadSnapshot,
  patchTask,
  removeAttachment,
  renameBoard,
} from "./db";
import { HttpError, errorResponse } from "./errors";
import { enforceLimit, parseColumn, parseDescription, parseDue, parseIndex, parseTitle } from "./validate";

const BOARD_RE = /^b_[a-f0-9]{16}$/;
const VISITOR_RE = /^v_[a-f0-9]{24}$/;

type SocketMeta = { visitorId: string; ip: string };

function snapshotEvent(board: BoardSnapshot, peers: number) {
  return { type: "snapshot" as const, peers, board };
}

export async function notifyBoard(env: Env, boardId: string, kind: "snapshot" | "expired"): Promise<void> {
  const stub = env.BOARD.get(env.BOARD.idFromName(boardId));
  await stub.fetch("https://board.internal/notify", {
    method: "POST",
    headers: { "content-type": "application/json", "x-tanbase-internal": "1", "x-board-id": boardId },
    body: JSON.stringify({ kind }),
  });
}

export function boardStub(env: Env, boardId: string): DurableObjectStub {
  return env.BOARD.get(env.BOARD.idFromName(boardId));
}

export class BoardRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") return await this.accept(request);
      if (url.pathname === "/notify") return Response.json(await this.notify(request));
      if (request.method === "GET") return Response.json(await this.read(request));
      if (request.method === "POST") return Response.json(await this.mutate(request));
      throw new HttpError(405, "method", "Method not allowed.");
    } catch (err) {
      return errorResponse(err);
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const meta = ws.deserializeAttachment() as SocketMeta | null;
    if (!meta) return;
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      if (text.length > 16_000) throw new HttpError(413, "too_large", "That update is too large.");
      const body = JSON.parse(text) as ClientEvent;
      await enforceLimit(this.env.WRITE_LIMIT, meta.ip);
      const boardId = this.boardIdFromTags(ws);
      const board = await this.owned(boardId, meta.visitorId);
      await this.applyEvent(board.id, body);
      await this.pushSnapshot(board.id);
    } catch (err) {
      const messageText = err instanceof HttpError ? err.message : "The board rejected that update.";
      try {
        ws.send(JSON.stringify({ type: "error", message: messageText }));
      } catch {
        // The socket closed while we were answering.
      }
    }
  }

  async webSocketClose(): Promise<void> {
    const peers = this.ctx.getWebSockets().length;
    this.sendAll(JSON.stringify({ type: "peers", peers }));
  }

  private async accept(request: Request): Promise<Response> {
    const { boardId, visitorId } = await this.auth(request, false);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // acceptWebSocket (not ws.accept) is what lets the DO hibernate between messages.
    this.ctx.acceptWebSocket(server, [boardId]);
    const ip = request.headers.get("x-client-ip") || "local";
    server.serializeAttachment({ visitorId, ip } satisfies SocketMeta);
    const board = await this.owned(boardId, visitorId);
    const snapshot = await loadSnapshot(this.env, board);
    server.send(JSON.stringify(snapshotEvent(snapshot, this.ctx.getWebSockets().length)));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async read(request: Request): Promise<BoardSnapshot> {
    const { boardId, visitorId } = await this.auth(request, false);
    return loadSnapshot(this.env, await this.owned(boardId, visitorId));
  }

  private async notify(request: Request): Promise<{ ok: true }> {
    const { boardId } = await this.auth(request, true);
    const body = (await request.json().catch(() => ({}))) as { kind?: string };
    if (body.kind === "expired") {
      this.sendAll(JSON.stringify({ type: "expired" }));
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(1000, "expired");
        } catch {
          // Already gone.
        }
      }
      return { ok: true };
    }
    await this.pushSnapshot(boardId);
    return { ok: true };
  }

  private async mutate(request: Request): Promise<{ snapshot: BoardSnapshot; attachment?: { id: string; r2Key: string } }> {
    const { boardId, visitorId } = await this.auth(request, false);
    await this.owned(boardId, visitorId);
    const body = (await request.json()) as Record<string, unknown>;
    const op = body.op;
    let attachment: { id: string; r2Key: string } | undefined;
    if (op === "rename") {
      const title = parseTitle(body.title, true);
      if (!title) throw new HttpError(400, "invalid", "Title is required.");
      await renameBoard(this.env, boardId, title);
    } else if (op === "create") {
      await this.applyEvent(boardId, {
        type: "create",
        title: String(body.title ?? ""),
        description: typeof body.description === "string" ? body.description : undefined,
        dueAt: body.dueAt as number | null | undefined,
        column: body.column as ColumnId | undefined,
      });
    } else if (op === "patch") {
      await this.applyEvent(boardId, { type: "patch", taskId: String(body.taskId ?? ""), title: body.title as string | undefined, description: body.description as string | undefined, dueAt: body.dueAt as number | null | undefined, column: body.column as ColumnId | undefined, index: body.index as number | undefined });
    } else if (op === "delete") {
      await this.applyEvent(boardId, { type: "delete", taskId: String(body.taskId ?? "") });
    } else if (op === "attach") {
      attachment = await insertAttachment(this.env, boardId, String(body.taskId ?? ""), {
        filename: typeof body.filename === "string" ? body.filename : "file",
        contentType: typeof body.contentType === "string" ? body.contentType : "",
        size: typeof body.size === "number" ? body.size : 0,
      });
    } else if (op === "detach") {
      await removeAttachment(this.env, boardId, String(body.attachmentId ?? ""));
    } else {
      throw new HttpError(400, "invalid", "Unknown board operation.");
    }
    const board = await this.owned(boardId, visitorId);
    const snapshot = await loadSnapshot(this.env, board);
    // Bytes land in R2 after the row exists. Broadcast once the worker finishes the put.
    if (op !== "attach") this.sendAll(JSON.stringify(snapshotEvent(snapshot, this.ctx.getWebSockets().length)));
    return { snapshot, attachment };
  }

  private async applyEvent(boardId: string, event: ClientEvent): Promise<void> {
    if (event.type === "create") {
      const title = parseTitle(event.title, true);
      if (!title) throw new HttpError(400, "invalid", "Title is required.");
      await createTask(this.env, boardId, {
        title,
        description: parseDescription(event.description) ?? "",
        dueAt: parseDue(event.dueAt) ?? null,
        column: parseColumn(event.column) ?? "todo",
      });
      return;
    }
    if (event.type === "delete") {
      if (!event.taskId) throw new HttpError(400, "invalid", "Missing card.");
      await deleteTask(this.env, boardId, event.taskId);
      return;
    }
    if (event.type === "patch") {
      if (!event.taskId) throw new HttpError(400, "invalid", "Missing card.");
      await patchTask(this.env, boardId, event.taskId, {
        title: parseTitle(event.title, false),
        description: parseDescription(event.description),
        dueAt: parseDue(event.dueAt),
        column: parseColumn(event.column),
        index: parseIndex(event.index),
      });
      return;
    }
    throw new HttpError(400, "invalid", "Unknown board event.");
  }

  private async pushSnapshot(boardId: string): Promise<void> {
    const row = await this.env.DB.prepare(`SELECT id, title, created_at, expires_at FROM boards WHERE id = ?`).bind(boardId).first<{ id: string; title: string; created_at: number; expires_at: number }>();
    if (!row || row.expires_at <= Date.now()) {
      this.sendAll(JSON.stringify({ type: "expired" }));
      return;
    }
    const snapshot = await loadSnapshot(this.env, { id: row.id, title: row.title, createdAt: row.created_at, expiresAt: row.expires_at });
    this.sendAll(JSON.stringify(snapshotEvent(snapshot, this.ctx.getWebSockets().length)));
  }

  private sendAll(payload: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // A peer left between the list and the send.
      }
    }
  }

  private boardIdFromTags(ws: WebSocket): string {
    const tag = this.ctx.getTags(ws)[0] ?? "";
    if (!BOARD_RE.test(tag)) throw new HttpError(400, "invalid", "Unknown board.");
    return tag;
  }

  private async auth(request: Request, internal: boolean): Promise<{ boardId: string; visitorId: string }> {
    const boardId = request.headers.get("x-board-id") ?? "";
    if (!BOARD_RE.test(boardId) || !this.env.BOARD.idFromName(boardId).equals(this.ctx.id)) {
      throw new HttpError(404, "not_found", "That board is gone.");
    }
    if (internal) {
      if (request.headers.get("x-tanbase-internal") !== "1") throw new HttpError(403, "forbidden", "Internal only.");
      return { boardId, visitorId: "" };
    }
    const visitorId = request.headers.get("x-visitor-id") ?? "";
    if (!VISITOR_RE.test(visitorId)) throw new HttpError(401, "visitor", "Missing visitor.");
    return { boardId, visitorId };
  }

  private async owned(boardId: string, visitorId: string) {
    const board = await getBoardForVisitor(this.env, boardId, visitorId);
    if (!board) throw new HttpError(404, "not_found", "That board is gone.");
    return board;
  }
}
