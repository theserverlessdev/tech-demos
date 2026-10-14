import { expect, test } from "bun:test";
import { COMPATIBILITY_DATE, DEMO_RESPONSE_CSP, demoLoaderId, forwardToLoader, wrapDemoResponse } from "./src/loader.ts";
import { slugFromHost, standaloneBlockedOnHost } from "./src/index.ts";

test("loader id includes a hash of source and compatibility date", async () => {
  const a = await demoLoaderId("hello-dynamic", "export default {}", COMPATIBILITY_DATE);
  const b = await demoLoaderId("hello-dynamic", "export default { changed: true }", COMPATIBILITY_DATE);
  const c = await demoLoaderId("hello-dynamic", "export default {}", "2026-01-01");
  expect(a.startsWith("hello-dynamic:")).toBe(true);
  expect(a).not.toBe(b);
  expect(a).not.toBe(c);
});

test("forwardToLoader strips cookie and authorization and sets x-dynamic-worker", () => {
  const req = new Request("https://tech-demos.theserverless.dev/demos/hello-dynamic/", {
    headers: {
      cookie: "sid=abc",
      authorization: "Bearer secret",
      accept: "text/html",
    },
  });
  const forwarded = forwardToLoader(req, "hello-dynamic:abc");
  expect(forwarded.headers.get("cookie")).toBeNull();
  expect(forwarded.headers.get("authorization")).toBeNull();
  expect(forwarded.headers.get("accept")).toBe("text/html");
  expect(forwarded.headers.get("x-dynamic-worker")).toBe("hello-dynamic:abc");
});

test("wrapDemoResponse sets sandbox CSP, nosniff, and the loader id", async () => {
  const res = wrapDemoResponse(
    new Response("ok", { headers: { "content-type": "text/html", "set-cookie": "sid=abc" } }),
    "hello-dynamic:abc",
  );
  expect(res.headers.get("content-security-policy")).toBe(DEMO_RESPONSE_CSP);
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("x-dynamic-worker")).toBe("hello-dynamic:abc");
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(await res.text()).toBe("ok");
});

test("standalone demos are blocked on a demo subdomain and allowed on the hub host", () => {
  expect(slugFromHost("edgechat.tech-demos.theserverless.dev")).toBe("edgechat");
  expect(slugFromHost("tech-demos.theserverless.dev")).toBeNull();
  expect(standaloneBlockedOnHost("standalone", "edgechat.tech-demos.theserverless.dev")).toBe(true);
  expect(standaloneBlockedOnHost("standalone", "tech-demos.theserverless.dev")).toBe(false);
  expect(standaloneBlockedOnHost("loader", "hello-dynamic.tech-demos.theserverless.dev")).toBe(false);
});
