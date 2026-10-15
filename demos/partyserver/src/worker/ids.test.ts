import { expect, test } from "bun:test";
import { ROOM_ID, ROOM_ID_RAND_LEN, ROOM_ID_TAG_LEN } from "../shared/protocol";
import { mintRoomId, roomIdSecret, verifyRoomId } from "./ids";

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

test("a different secret does not verify the same id", async () => {
  const id = await mintRoomId(SECRET);
  expect(await verifyRoomId("other-secret-value-not-the-test-pair", id)).toBe(false);
});

test("roomIdSecret prefers ROOM_SECRET and falls back to TURNSTILE_SECRET", () => {
  expect(roomIdSecret({ ROOM_SECRET: " dedicated ", TURNSTILE_SECRET: SECRET })).toBe("dedicated");
  expect(roomIdSecret({ TURNSTILE_SECRET: SECRET })).toBe(SECRET);
  expect(roomIdSecret({ ROOM_SECRET: "  ", TURNSTILE_SECRET: SECRET })).toBe(SECRET);
  expect(roomIdSecret({})).toBe("");
});
