/** True when a chat commit landed while the dream model was running. */
export function staleDreamHead(before: string | null, after: string | null): boolean {
  return before !== after;
}

export const DREAM_STALE_REASON = "Memory changed during the dream; nothing was committed.";

/** ChatAgent.purge and MemoryAgent.wipe both go through destroy(). */
export async function purgeChatAgent(agent: { destroy(): Promise<void> }): Promise<void> {
  await agent.destroy();
}

/**
 * 24h expiry: chat first, then the repo, then the D1 row, then this MemoryAgent.
 * destroy() is last because it aborts the isolate.
 */
export async function wipeSession(steps: {
  purgeChat: () => Promise<void>;
  deleteRepo?: () => Promise<void>;
  deleteVisitorRow: () => Promise<void>;
  destroyMemory: () => Promise<void>;
}): Promise<void> {
  await steps.purgeChat();
  if (steps.deleteRepo) await steps.deleteRepo();
  await steps.deleteVisitorRow();
  await steps.destroyMemory();
}
