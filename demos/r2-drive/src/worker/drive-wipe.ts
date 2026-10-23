import { deletePrefix, type DavBucket } from "./bucket";

/**
 * Wipe the prefix even when the Durable Object name is missing, as long as
 * schedule() stored the drive id. Both missing is a loud failure.
 */
export async function completeWipe(input: {
  name: string | undefined;
  storedId: string | undefined;
  bucket: DavBucket;
  markWiped: (id: string, now: number) => Promise<void>;
  deleteAll: () => Promise<void>;
  now: number;
}): Promise<boolean> {
  if (!input.name) {
    console.error(JSON.stringify({ event: "wipe_missing_name", storedId: input.storedId ?? null }));
  }
  const id = input.name || input.storedId;
  if (!id) return false;
  await deletePrefix(input.bucket, `drives/${id}/`);
  await input.markWiped(id, input.now);
  await input.deleteAll();
  return true;
}
