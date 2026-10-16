import { expect, test } from "bun:test";
import { parseRedirectUris, redirectUriAllowed } from "../src/worker/redirect";

const registered = ["https://app.example/callback", "http://127.0.0.1:8788/"];

test("exact redirect_uri matches", () => {
  expect(redirectUriAllowed("https://app.example/callback", registered)).toBeTrue();
  expect(redirectUriAllowed("http://127.0.0.1:8788/", registered)).toBeTrue();
});

test("prefix, query extras, and slash folding are rejected", () => {
  expect(redirectUriAllowed("https://app.example/callback/extra", registered)).toBeFalse();
  expect(redirectUriAllowed("https://app.example/callback?x=1", registered)).toBeFalse();
  expect(redirectUriAllowed("http://127.0.0.1:8788", registered)).toBeFalse();
  expect(redirectUriAllowed("https://evil.example/callback", registered)).toBeFalse();
  expect(redirectUriAllowed("", registered)).toBeFalse();
});

test("parseRedirectUris reads a JSON array and ignores junk", () => {
  expect(parseRedirectUris('["https://a/","https://b/"]')).toEqual(["https://a/", "https://b/"]);
  expect(parseRedirectUris("not-json")).toEqual([]);
  expect(parseRedirectUris("[1,2]")).toEqual([]);
});
