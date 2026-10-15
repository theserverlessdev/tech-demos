import { deleteBoardData, markOverdue, listExpiredBoardIds, sweepOrphans, sweepUnusedVisitors } from "./db";
import { notifyBoard } from "./board";

export async function sweep(env: Env): Promise<{
  overdueBoards: number;
  expired: number;
  removedObjects: number;
  orphans: number;
  unusedVisitors: number;
}> {
  const now = Date.now();
  const overdueBoards = await markOverdue(env, now);
  const expired = await listExpiredBoardIds(env, now);
  let removedObjects = 0;
  for (const boardId of expired) {
    removedObjects += await deleteBoardData(env, boardId);
  }
  const orphans = await sweepOrphans(env);
  const unusedVisitors = await sweepUnusedVisitors(env);
  const touched = new Set<string>([...overdueBoards, ...expired]);
  for (const boardId of touched) {
    try {
      await notifyBoard(env, boardId, expired.includes(boardId) ? "expired" : "snapshot");
    } catch (err) {
      console.error(JSON.stringify({ event: "notify_failed", boardId, error: String(err) }));
    }
  }
  return { overdueBoards: overdueBoards.length, expired: expired.length, removedObjects, orphans, unusedVisitors };
}
