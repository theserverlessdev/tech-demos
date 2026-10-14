import { expect, test } from "bun:test";
import hub from "./src/index.ts";

function env(onGet: () => void = () => {}) {
  return {
    LOADER: {
      get() {
        onGet();
        throw new Error("LOADER.get should not run");
      },
    },
    ASSETS: {
      fetch() {
        throw new Error("ASSETS should not run");
      },
    },
  };
}

test("POST to a loader demo is 405 and never calls LOADER.get", async () => {
  let loads = 0;
  const res = await hub.fetch(
    new Request("https://tech-demos.theserverless.dev/demos/hello-dynamic/", {
      method: "POST",
      body: "x=1",
    }),
    env(() => {
      loads += 1;
    }) as never,
  );
  expect(res.status).toBe(405);
  expect(res.headers.get("allow")).toBe("GET, HEAD");
  expect(await res.text()).toBe("Method not allowed");
  expect(loads).toBe(0);
});

test("PUT on a hello-dynamic subdomain is 405", async () => {
  const res = await hub.fetch(
    new Request("https://hello-dynamic.tech-demos.theserverless.dev/", { method: "PUT" }),
    env() as never,
  );
  expect(res.status).toBe(405);
});
