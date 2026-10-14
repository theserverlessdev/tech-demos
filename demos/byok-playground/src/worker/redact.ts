import { apiHeaders } from "./headers";

const PLACEHOLDER = "[redacted]";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace only the exact pasted key. Used on success bodies. */
export function redactExact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed.length < 4) continue;
    out = out.split(trimmed).join(PLACEHOLDER);
  }
  return out;
}

/** Exact key plus Bearer / sk- patterns. Used on error text and logs only. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = redactExact(text, secrets);
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed.length < 4) continue;
    try {
      out = out.replace(new RegExp(escapeRegExp(trimmed), "gi"), PLACEHOLDER);
    } catch {
      /* split already covered the literal */
    }
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-+=/]{8,}/gi, `Bearer ${PLACEHOLDER}`);
  out = out.replace(/\bsk-[A-Za-z0-9_\-]{8,}/g, PLACEHOLDER);
  return out;
}

/** Hold back key.length-1 chars so a key split across chunks is still redacted. */
export function createExactRedactor(secrets: readonly string[]) {
  const hold = Math.max(0, ...secrets.map((secret) => Math.max(0, secret.trim().length - 1)));
  let carry = "";
  return {
    push(chunk: string, last = false): string {
      const redacted = redactExact(carry + chunk, secrets);
      if (last || hold === 0) {
        carry = "";
        return redacted;
      }
      if (redacted.length <= hold) {
        carry = redacted;
        return "";
      }
      const emit = redacted.slice(0, redacted.length - hold);
      carry = redacted.slice(emit.length);
      return emit;
    },
    flush(): string {
      const out = redactExact(carry, secrets);
      carry = "";
      return out;
    },
  };
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
