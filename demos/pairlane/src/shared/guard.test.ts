import { expect, test } from "bun:test";
import { isExpired, randomRoomId, ROOM_ID, ROOM_TTL_MS } from "./protocol";

test("room ids are 8 unambiguous letters and rooms last 10 minutes", () => {
  const id = randomRoomId(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
  expect(ROOM_ID.test(id)).toBe(true);
  expect(id.includes("0")).toBe(false);
  expect(id.includes("1")).toBe(false);
  expect(ROOM_TTL_MS).toBe(10 * 60 * 1000);
  expect(isExpired(1_000, 1_000)).toBe(true);
  expect(isExpired(1_001, 1_000)).toBe(false);
});

test("the room source does not mention file bytes", async () => {
  const room = await Bun.file(new URL("../worker/room.ts", import.meta.url)).text();
  expect(room).not.toContain("sha256");
  expect(room).not.toContain("arrayBuffer");
  expect(room).not.toContain("from \"../shared/file");
  const readme = await Bun.file(new URL("../../README.md", import.meta.url)).text();
  const app = await Bun.file(new URL("../client/app.ts", import.meta.url)).text();
  expect(app).not.toContain("save.click(");
  expect(app).toContain("revokeObjectURL");
  const page = await Bun.file(new URL("../../public/index.html", import.meta.url)).text();
  for (const text of [readme, page]) {
    expect(text.toLowerCase()).toContain("misuse can be reported");
  }
});
