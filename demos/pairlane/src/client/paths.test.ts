import { expect, test } from "bun:test";
import { clientBase, roomLink, socketUrl } from "./paths";

test("links stay on the hub prefix and the subdomain root", () => {
  expect(clientBase("/demos/pairlane/")).toBe("/demos/pairlane");
  expect(clientBase("/demos/pairlane")).toBe("/demos/pairlane");
  expect(clientBase("/")).toBe("");
  expect(roomLink("https://pairlane.tech-demos.theserverless.dev", "", "k7m2pqrs")).toBe(
    "https://pairlane.tech-demos.theserverless.dev/?r=k7m2pqrs",
  );
  expect(roomLink("https://tech-demos.theserverless.dev", "/demos/pairlane", "k7m2pqrs")).toBe(
    "https://tech-demos.theserverless.dev/demos/pairlane/?r=k7m2pqrs",
  );
  expect(socketUrl("https:", "pairlane.tech-demos.theserverless.dev", "", "k7m2pqrs", "abc")).toBe(
    "wss://pairlane.tech-demos.theserverless.dev/ws/k7m2pqrs?cid=abc",
  );
});
