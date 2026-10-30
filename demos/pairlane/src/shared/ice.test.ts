import { expect, test } from "bun:test";
import { connectSources, iceServersFromEnv, turnUrls } from "./ice";
import { STUN_URL } from "./protocol";

test("STUN is always on and TURN stays off until url, username, and credential are set", () => {
  expect(iceServersFromEnv({}).servers).toEqual([{ urls: STUN_URL }]);
  expect(iceServersFromEnv({ TURN_URLS: "turn:turn.example:3478" }).turn).toBe(false);
  expect(iceServersFromEnv({ TURN_URLS: "turn:turn.example:3478", TURN_USERNAME: "u" }).turn).toBe(false);
  const full = iceServersFromEnv({
    TURN_URLS: "turn:turn.cloudflare.com:3478?transport=udp, turns:turn.cloudflare.com:5349",
    TURN_USERNAME: "user",
    TURN_CREDENTIAL: "secret",
  });
  expect(full.turn).toBe(true);
  expect(full.servers[0]).toEqual({ urls: STUN_URL });
  expect(full.servers[1]?.username).toBe("user");
  expect(turnUrls("not a url, stun:stun.cloudflare.com:3478")).toEqual(["stun:stun.cloudflare.com:3478"]);
});

test("CSP allows STUN and TURN schemes so a configured server is not blocked", () => {
  const sources = connectSources(undefined);
  expect(sources).toContain("stun:");
  expect(sources).toContain("turn:");
  expect(sources.join(" ")).not.toContain(STUN_URL);
  const withHost = connectSources("turn:turn.cloudflare.com:3478?transport=udp");
  expect(withHost).toContain("turn:turn.cloudflare.com:3478");
  expect(withHost.join(" ")).not.toContain("transport");
});
