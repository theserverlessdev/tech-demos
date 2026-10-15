import { expect, test } from "bun:test";
import { ROOM_ID, ROOM_ID_RAND_LEN, ROOM_ID_TAG_LEN } from "../shared/protocol";
import { mintRoomId, verifyRoomId } from "./ids";

const SECRET = "1x0000000000000000000000000000000AA";

test("minted ids match ROOM_ID and verify", async () => {
  const id = await mintRoomId(SECRET);
  expect(id.length).toBe(ROOM_ID_RAND_LEN + ROOM_ID_TAG_LEN);
  expect(ROOM_ID.test(id)).toBe(true);
  expect(await verifyRoomId(SECRET, id)).toBe(true);
});

test("a flipped tag does not verify", async () => {
  const id = await mintRoomId(SECRET);
  const tampered = id.slice(0, -1) + (id.endsWith("a") ? "b" : "a");
  expect(ROOM_ID.test(tampered)).toBe(true);
  expect(await verifyRoomId(SECRET, tampered)).toBe(false);
});

test("empty secret never verifies", async () => {
  const id = await mintRoomId(SECRET);
  expect(await verifyRoomId("", id)).toBe(false);
});

test("a 10-char legacy id is rejected by ROOM_ID", () => {
  expect(ROOM_ID.test("abcdefghjk")).toBe(false);
});
