/**
 * Serialize async work on one isolate. Durable Object handlers can interleave
 * after an await (the input gate opens), so repo mutations go through this queue.
 */
export function serialQueue(): <T>(work: () => Promise<T>) => Promise<T> {
  let chain: Promise<void> = Promise.resolve();
  return function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = chain.then(work, work);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
