import { expect, test } from "bun:test";
import { HttpError, handleApi } from "./api";
import { allowedRequestOrigin } from "./origin";

test("room creation and sockets allow the two demo origins, and loopback only when local", () => {
  expect(allowedRequestOrigin("https://pairlane.tech-demos.theserverless.dev", false)).toBe(true);
  expect(allowedRequestOrigin("https://tech-demos.theserverless.dev", false)).toBe(true);
  expect(allowedRequestOrigin("http://tech-demos.theserverless.dev", false)).toBe(false);
  expect(allowedRequestOrigin("https://other.tech-demos.theserverless.dev", false)).toBe(false);
  expect(allowedRequestOrigin("https://theserverless.dev", false)).toBe(false);
  expect(allowedRequestOrigin("https://evil.example", false)).toBe(false);
  expect(allowedRequestOrigin(null, false)).toBe(false);
  expect(allowedRequestOrigin("http://127.0.0.1:8794", false)).toBe(false);
  expect(allowedRequestOrigin("http://127.0.0.1:8794", true)).toBe(true);
  expect(allowedRequestOrigin("http://localhost:8794", true)).toBe(true);
  expect(allowedRequestOrigin("http://evil.example", true)).toBe(false);
});

test("GET /api/rooms/:id is not a route", async () => {
  const request = new Request("https://tech-demos.theserverless.dev/api/rooms/abcdefgh");
  try {
    await handleApi(request, {} as never, "/api/rooms/abcdefgh", false);
    throw new Error("expected 404");
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
  }
});
