import { redactExact } from "../shared/text";
import { apiHeaders } from "./headers";

export { createExactRedactor, redactExact } from "../shared/text";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Exact key plus Bearer / sk- patterns. Used on error text and logs only. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = redactExact(text, secrets);
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed.length < 4) continue;
    try {
      out = out.replace(new RegExp(escapeRegExp(trimmed), "gi"), "[redacted]");
    } catch {
      /* split already covered the literal */
    }
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-+=/]{8,}/gi, "Bearer [redacted]");
  out = out.replace(/\bsk-[A-Za-z0-9_\-]{8,}/g, "[redacted]");
  return out;
}

export function redactUnknown(value: unknown, secrets: readonly string[]): string {
  if (value instanceof Error) return redact(`${value.name}: ${value.message}`, secrets);
  return redact(String(value), secrets);
}

export type LogSink = (line: string) => void;

export function createLogger(secrets: readonly string[], sink: LogSink = (line) => console.error(line)) {
  return {
    error(event: string, err: unknown, extra: Record<string, unknown> = {}) {
      const payload = {
        event,
        error: redactUnknown(err, secrets).slice(0, 300),
        ...Object.fromEntries(Object.entries(extra).map(([key, val]) => [key, typeof val === "string" ? redact(val, secrets).slice(0, 200) : val])),
      };
      sink(JSON.stringify(payload));
    },
  };
}

export function jsonError(status: number, code: string, message: string, secrets: readonly string[] = []): Response {
  return Response.json(
    { error: { code, message: redact(message, secrets) } },
    { status, headers: apiHeaders("json") },
  );
}
