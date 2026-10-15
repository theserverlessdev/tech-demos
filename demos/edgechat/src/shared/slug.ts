export class RoomSlugError extends Error {
  readonly code = "bad_slug";
  constructor() {
    super("Use letters or numbers in the room name.");
    this.name = "RoomSlugError";
  }
}

export type RoomSlug = { id: string; name: string };

/** Letters and numbers from any script. Empty input becomes the lobby. */
export function slugRoom(raw: string): RoomSlug {
  const name = raw.trim().slice(0, 48);
  if (!name) return { id: "lobby", name: "lobby" };
  const id = name
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!id) throw new RoomSlugError();
  return { id, name };
}
