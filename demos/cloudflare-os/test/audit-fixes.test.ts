import { expect, test } from "bun:test";
import { GADGET_IFRAME_SANDBOX, gadgetIsolationScript } from "../src/client/gadget-isolation";
import { safeGadgetOpenUrl } from "../src/client/open-url";
import {
  AGENT_STEP_RESERVE_USD,
  applySettle,
  COMPLETION_RESERVE_USD,
  hasReportedUsage,
  PRICE_IN,
  PRICE_OUT,
  usageCost,
} from "../src/worker/cost";
import { idleErrorMessage, idleReason, nextIdleAlarmAt, SESSION_IDLE_MS } from "../src/worker/idle";
import { isAllowedOrigin } from "../src/worker/origin";
import {
  APPROVAL_TIMEOUT_MS,
  GADGET_CALL_TIMEOUT_MS,
  GADGET_METHOD_TIMEOUT_MS,
  WEB_FETCH_TIMEOUT_MS,
} from "../src/worker/timeouts";

test("usageCost fails closed when usage is missing or unparseable", () => {
  const reserved = 0.01;
  expect(hasReportedUsage(undefined)).toBe(false);
  expect(hasReportedUsage({})).toBe(false);
  expect(hasReportedUsage({ prompt_tokens: "nope", completion_tokens: null })).toBe(false);
  expect(usageCost(undefined, reserved)).toEqual({ usd: reserved, tokensIn: 0, tokensOut: 0, estimated: true });
  expect(usageCost({}, reserved)).toEqual({ usd: reserved, tokensIn: 0, tokensOut: 0, estimated: true });
  expect(usageCost({ prompt_tokens: -4 }, reserved).estimated).toBe(true);
});

test("usageCost uses reported tokens when present", () => {
  const cost = usageCost({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
  expect(cost.estimated).toBe(false);
  expect(cost.usd).toBeCloseTo(PRICE_IN * 1_000_000 + PRICE_OUT * 1_000_000);
  expect(cost.usd).toBeCloseTo(0.65);
});

test("settle keeps the reservation when usage is omitted instead of refunding to $0", () => {
  const reserved = AGENT_STEP_RESERVE_USD;
  const afterReserve = reserved;
  const omitted = usageCost(undefined, reserved);
  expect(applySettle(afterReserve, reserved, omitted.usd)).toBeCloseTo(reserved);
  const reported = usageCost({ prompt_tokens: 100, completion_tokens: 50 });
  expect(applySettle(afterReserve, reserved, reported.usd)).toBeCloseTo(reported.usd);
  expect(applySettle(afterReserve, reserved, 0)).toBe(0);
});

test("glm-5.3-flash unit prices match the published Flash page, not full GLM-5.3", () => {
  expect(PRICE_IN * 1_000_000).toBeCloseTo(0.15);
  expect(PRICE_OUT * 1_000_000).toBeCloseTo(0.5);
  expect(COMPLETION_RESERVE_USD).toBeGreaterThan(0);
});

test("gadget-call timeout covers the 90s approval window plus the WEB fetch", () => {
  expect(APPROVAL_TIMEOUT_MS).toBe(90_000);
  expect(WEB_FETCH_TIMEOUT_MS).toBe(8_000);
  expect(GADGET_METHOD_TIMEOUT_MS).toBe(20_000);
  expect(GADGET_CALL_TIMEOUT_MS).toBe(APPROVAL_TIMEOUT_MS + WEB_FETCH_TIMEOUT_MS + GADGET_METHOD_TIMEOUT_MS);
  expect(GADGET_CALL_TIMEOUT_MS).toBeGreaterThan(APPROVAL_TIMEOUT_MS);
});

test("idle policy ignores ping-scale gaps and trips after 20 minutes", () => {
  const t0 = 1_000_000;
  expect(idleReason(t0 + 20_000, t0)).toBeNull();
  expect(idleReason(t0 + SESSION_IDLE_MS - 1, t0)).toBeNull();
  expect(idleReason(t0 + SESSION_IDLE_MS, t0)).toBe("idle");
  expect(nextIdleAlarmAt(t0, t0)).toBe(t0 + SESSION_IDLE_MS);
  expect(idleErrorMessage()).toMatch(/20 minutes idle/);
});

test("origin allowlist is defense-in-depth: no Origin and localhost pass", () => {
  const url = new URL("http://127.0.0.1:8787/api");
  expect(isAllowedOrigin(null, url)).toBe(true);
  expect(isAllowedOrigin("http://localhost:8787", url)).toBe(true);
  expect(isAllowedOrigin("http://127.0.0.1:8795", url)).toBe(true);
  expect(isAllowedOrigin("https://evil.example", url)).toBe(false);
  expect(isAllowedOrigin("https://tech-demos.theserverless.dev", url)).toBe(true);
});

test("gadget iframe sandbox is allow-scripts only and locks window.open", () => {
  expect(GADGET_IFRAME_SANDBOX).toBe("allow-scripts");
  expect(GADGET_IFRAME_SANDBOX).not.toContain("allow-popups");
  const script = gadgetIsolationScript();
  expect(script).toContain('type: "open-url"');
  expect(script).toContain("configurable: false");
  expect(script).toContain("writable: false");
});

test("parent only opens http(s) gadget links", () => {
  expect(safeGadgetOpenUrl("https://news.ycombinator.com/item?id=1")).toBe("https://news.ycombinator.com/item?id=1");
  expect(safeGadgetOpenUrl("http://example.com")).toBe("http://example.com/");
  expect(safeGadgetOpenUrl("javascript:alert(1)")).toBeNull();
  expect(safeGadgetOpenUrl("https://user:pass@evil.test")).toBeNull();
  expect(safeGadgetOpenUrl({ href: "https://example.com" })).toBeNull();
});

test("headlines refresh emits the documented fetching phase", async () => {
  const src = await Bun.file(new URL("../src/blueprints/headlines/server.js", import.meta.url)).text();
  expect(src).toContain('phase: "fetching"');
  expect(src).toContain("await web.getJson(FEED_URL)");
  expect(src.indexOf('phase: "fetching"')).toBeGreaterThan(src.indexOf("await web.getJson(FEED_URL)"));
});

test("mobile Gadgets view clips off-canvas drawers and meets 44px tap height", async () => {
  const css = await Bun.file(new URL("../public/assets/shell.css", import.meta.url)).text();
  expect(css).toMatch(/overflow-x:\s*hidden/);
  expect(css).toMatch(/\.gadgets[^}]*overflow-x:\s*hidden/);
  expect(css).toContain("min-height: 44px");
  const shell = await Bun.file(new URL("../src/client/shell.ts", import.meta.url)).text();
  expect(shell).not.toContain("allow-popups-to-escape-sandbox");
  expect(shell).toContain("GADGET_IFRAME_SANDBOX");
  const origin = await Bun.file(new URL("../src/worker/origin.ts", import.meta.url)).text();
  expect(origin).toContain("defense-in-depth");
});
