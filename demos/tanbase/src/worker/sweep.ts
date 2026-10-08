import { deleteBoardData, markOverdue, listExpiredBoardIds } from "./db";
import { notifyBoard } from "./board";

export async function sweep(env: Env): Promise<{ overdueBoards: number; expired: number; removedObjects: number }> {
  const now = Date.now();
  const overdueBoards = await markOverdue(env, now);
  const expired = await listExpiredBoardIds(env, now);
  let removedObjects = 0;
  for (const boardId of expired) {
    removedObjects += await deleteBoardData(env, boardId);
  }
  const touched = new Set<string>([...overdueBoards, ...expired]);
  for (const boardId of touched) {
    try {
      await notifyBoard(env, boardId, expired.includes(boardId) ? "expired" : "snapshot");
    } catch (err) {
      console.error(JSON.stringify({ event: "notify_failed", boardId, error: String(err) }));
    }
  }
  return { overdueBoards: overdueBoards.length, expired: expired.length, removedObjects };
}
