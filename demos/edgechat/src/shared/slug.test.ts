import { expect, test } from "bun:test";
import { RoomSlugError, slugRoom } from "./slug.ts";

test("empty input becomes lobby", () => {
  expect(slugRoom("")).toEqual({ id: "lobby", name: "lobby" });
  expect(slugRoom("   ")).toEqual({ id: "lobby", name: "lobby" });
});

test("latin names slug to kebab", () => {
  expect(slugRoom("Hello World")).toEqual({ id: "hello-world", name: "Hello World" });
});

test("non-Latin letters stay as the room id", () => {
  expect(slugRoom("日本語").id).toBe("日本語");
  expect(slugRoom("नमस्ते").id).toBe("नमस्ते");
});

test("punctuation-only names are rejected instead of mapping to lobby", () => {
  expect(() => slugRoom("!!!")).toThrow(RoomSlugError);
  expect(() => slugRoom("___")).toThrow(RoomSlugError);
});
