import { DESK_PATH, PAGE_CSP, clampDeviceLevel, expandIpv6, formatBudgetUsd, ipSpendKey, isScopedGuardCode, isStaticAssetPath, MAX_DESK_TURNS_PER_DAY, MAX_HELLO_FAILS, MAX_REMINDER_SCHEDULES, MAX_TOOL_CALLS_PER_ROUND, networkKey, nextHelloFails, utcDayKey, visitorCapUsd, VISITOR_BUDGET_SHARE } from "../src/worker/gates";
import { isLocalHost, isLocalRequest, isTestSiteKey, resolveTurnstileSecret, TURNSTILE_TEST_SECRET, TURNSTILE_TEST_SITE_KEY } from "../src/worker/turnstile";

function check(ok: unknown, label: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) process.exitCode = 1;
}

check(DESK_PATH.test("/agents/apollo/abcdefghijkl"), "desk path accepts a 12-char id");
check(DESK_PATH.test("/agents/apollo/abcdefghijkl/"), "desk path accepts a trailing slash");
check(!DESK_PATH.test("/agents/apollo/abcdefghijkl/sub/apollo/child"), "desk path rejects a child facet");
check(!DESK_PATH.test("/agents/apollo/short"), "desk path rejects a short id");
check(!DESK_PATH.test("/agents/meter/abcdefghijkl"), "desk path rejects a different class");

check(isStaticAssetPath("/"), "root is a static path");
check(isStaticAssetPath("/index.html"), "index.html is a static path");
check(isStaticAssetPath("/favicon.svg"), "favicon is a static path");
check(isStaticAssetPath("/assets/desk.css"), "assets are static paths");
check(!isStaticAssetPath("/foo/assets/desk.css"), "nested unknown paths are not static");
check(!isStaticAssetPath("/agents/apollo/abcdefghijkl"), "agent paths are not static");

check(clampDeviceLevel(1e9) === 100, "device level clamps a huge volume");
check(clampDeviceLevel(-50) === 0, "device level clamps a negative brightness");
check(clampDeviceLevel(40) === 40, "device level keeps a valid number");
check(clampDeviceLevel("nope") === undefined, "device level ignores a non-number");
check(clampDeviceLevel(Number.NaN) === undefined, "device level ignores NaN");

check(formatBudgetUsd(0.005) === "0.005", "small budgets keep three decimals");
check(formatBudgetUsd(0.1) === "0.10", "the default budget stays at two decimals");
check(visitorCapUsd(0.1) === 0.015, "a visitor may spend 15% of $0.10");
check(VISITOR_BUDGET_SHARE === 0.15, "visitor share is 15%");
check(ipSpendKey("203.0.113.8", "2026-10-14") === "ip:2026-10-14:203.0.113.8", "IP spend key includes the UTC day");
check(utcDayKey(new Date("2026-10-14T23:00:00.000Z")) === "2026-10-14", "day key is UTC");

check(networkKey("203.0.113.8") === "203.0.113.8", "IPv4 network key is the address");
check(networkKey("2001:db8::1") === "2001:db8:0:0", "compressed IPv6 collapses to /64");
check(networkKey("2001:0db8:0000:0000:0000:0000:0000:0001") === "2001:db8:0:0", "expanded IPv6 collapses to the same /64");
check(networkKey("2001:db8:1:2:3:4:5:6") === "2001:db8:1:2", "IPv6 /64 keeps the first four hextets");
check(networkKey("2001:db8:0:0:aaaa:bbbb:cccc:dddd") === networkKey("2001:db8::1"), "addresses in one /64 share a key");
check(networkKey("2001:db8:0:1::") !== networkKey("2001:db8:0:0::"), "a different /64 gets a different key");
check(networkKey("[2001:db8::1]") === "2001:db8:0:0", "bracketed IPv6 collapses to /64");
check(networkKey("fe80::1%eth0") === "fe80:0:0:0", "IPv6 zone id is stripped before /64");
check(networkKey("::ffff:203.0.113.8") === "203.0.113.8", "IPv4-mapped IPv6 uses the IPv4 address");
check(networkKey("desk:abc123def456") === "desk:abc123def456", "desk spend keys are not treated as IPv6");
check(networkKey("local") === "local", "local spend key stays local");
check(expandIpv6("not-an-ip") === null, "expandIpv6 rejects a hostname");
check(ipSpendKey("2001:db8::aa", "2026-10-14") === "ip:2026-10-14:2001:db8:0:0", "IP spend key uses the IPv6 /64");

check(isScopedGuardCode("turnstile_required"), "turnstile errors stay on the requesting tab");
check(isScopedGuardCode("rate_limited"), "rate-limit errors stay on the requesting tab");
check(isScopedGuardCode("desk_limited"), "desk-limit errors stay on the requesting tab");
check(isScopedGuardCode("budget"), "budget errors stay on the requesting tab");
check(!isScopedGuardCode("turn_failed"), "unexpected turn failures still broadcast");

check(MAX_HELLO_FAILS === 5, "a connection gets five failed hellos");
check(nextHelloFails(0).fails === 1 && !nextHelloFails(0).close, "the first failed hello stays open");
check(nextHelloFails(4).fails === 5 && nextHelloFails(4).close, "the fifth failed hello closes the socket");

const llmIn = 0.15 / 1_000_000;
const llmOut = 0.5 / 1_000_000;
const tiny = Math.ceil(JSON.stringify([{ role: "user", content: "hi" }]).length / 3) * llmIn + 700 * llmOut;
check(tiny < 12_000 * llmIn + 700 * llmOut, "a short prompt reserves less than the old 12k-token worst case");

check(MAX_TOOL_CALLS_PER_ROUND === 4, "a model round keeps at most 4 tool calls");
check(MAX_REMINDER_SCHEDULES === 20, "a desk holds at most 20 reminder schedules");
check(MAX_DESK_TURNS_PER_DAY === 60, "a desk is capped at 60 turns a day");

check(PAGE_CSP.includes("default-src 'self'"), "CSP sets default-src");
check(PAGE_CSP.includes("https://challenges.cloudflare.com"), "CSP allows the Turnstile iframe");
check(PAGE_CSP.includes("frame-ancestors 'none'"), "CSP forbids framing");
check(PAGE_CSP.includes("base-uri 'none'"), "CSP forbids a base URI");

check(isLocalHost("127.0.0.1"), "loopback IPv4 is local");
check(isLocalHost("localhost"), "localhost is local");
check(!isLocalHost("tech-demos.theserverless.dev"), "the live host is not local");
check(isTestSiteKey(TURNSTILE_TEST_SITE_KEY), "the published test site key is detected");
check(isTestSiteKey(undefined), "a missing site key is treated as the test key");
check(!isTestSiteKey("0x4AAAAAAFRgrYxN6MUtsC0C"), "a production site key is not the test key");

check(resolveTurnstileSecret("127.0.0.1", "127.0.0.1", "", "").ok === true, "localhost without a secret uses the test secret");
check(resolveTurnstileSecret("tech-demos.theserverless.dev", "203.0.113.8", "", undefined).ok === false, "public host without a secret fails closed");
check(resolveTurnstileSecret("tech-demos.theserverless.dev", "203.0.113.8", "", TURNSTILE_TEST_SECRET).ok === false, "test secret on a public host fails closed");
check(resolveTurnstileSecret("apollo-desk.tech-demos.theserverless.dev", "203.0.113.8", "", "real-secret-value").ok === true, "a real secret on a public host is accepted");
check(isLocalRequest("tech-demos.theserverless.dev", "127.0.0.1", ""), "wrangler-dev route host with a loopback IP is local");
check(isLocalRequest("tech-demos.theserverless.dev", "203.0.113.8", "local"), "ENVIRONMENT=local counts as local");
check(!isLocalRequest("tech-demos.theserverless.dev", "203.0.113.8", ""), "a public IP on the route host is not local");

if (process.exitCode) {
  console.error("gates tests failed");
  process.exit(1);
}
console.log("gates tests passed");
