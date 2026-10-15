import { describe, expect, test } from "bun:test";
import { createExactRedactor, createLogger, jsonError, redact, redactExact, redactUnknown } from "../src/worker/redact";
import { failFromUpstream } from "../src/worker/proxy";

const KEY = "sk-secret-test-key-12345DEADBEEF";

describe("key never appears in logs or errors", () => {
  test("redact strips the literal key and Bearer tokens", () => {
    const raw = `upstream 401: Incorrect API key provided: ${KEY}. Bearer ${KEY} is invalid.`;
    const cleaned = redact(raw, [KEY]);
    expect(cleaned).not.toContain(KEY);
    expect(cleaned).not.toContain("sk-secret");
    expect(cleaned).toContain("[redacted]");
  });

  test("generic Bearer/sk- patterns are not applied by exact-key success redaction", () => {
    expect(redactExact("Bearer other-token-not-the-key sk-not-the-pasted-key", [KEY])).toBe("Bearer other-token-not-the-key sk-not-the-pasted-key");
  });

  test("success-body redactor only replaces the exact key, holding a prefix across chunks", () => {
    const redactor = createExactRedactor([KEY]);
    const prefix = KEY.slice(0, 8);
    const rest = KEY.slice(8);
    expect(redactExact(`hello ${KEY} world`, [KEY])).toBe("hello [redacted] world");
    expect(redactExact("Bearer other-token-not-the-key", [KEY])).toBe("Bearer other-token-not-the-key");
    const first = redactor.push(`start ${prefix}`);
    expect(first).not.toContain(KEY);
    const second = redactor.push(`${rest} end`, true);
    const joined = first + second;
    expect(joined).not.toContain(KEY);
    expect(joined).toContain("[redacted]");
    expect(joined).toContain("start");
    expect(joined).toContain("end");
  });

  test("generic Bearer/sk- patterns are for errors and logs only", () => {
    const lines: string[] = [];
    const log = createLogger([KEY], (line) => lines.push(line));
    log.error("upstream_failed", new Error(`401 invalid api key: ${KEY}`), { body: `{"error":"${KEY}"}` });
    const joined = lines.join("\n");
    expect(joined).not.toContain(KEY);
    expect(joined).toContain("[redacted]");
    expect(joined).toContain("upstream_failed");
  });

  test("jsonError body never contains the key and sets sandbox CSP", async () => {
    const res = jsonError(401, "upstream", `Incorrect API key provided: ${KEY}`, [KEY]);
    const body = await res.text();
    expect(body).not.toContain(KEY);
    expect(body).toContain("[redacted]");
    expect(JSON.parse(body).error.code).toBe("upstream");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });

  test("failFromUpstream redacts a provider error that echoes the key", () => {
    const err = failFromUpstream(401, JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }), [KEY]);
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain("[redacted]");
    expect(redactUnknown(err, [KEY])).not.toContain(KEY);
  });
});
