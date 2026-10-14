const PLACEHOLDER = "[redacted]";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Drop any occurrence of the visitor key (and obvious Bearer tokens) from a string. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed.length < 4) continue;
    out = out.split(trimmed).join(PLACEHOLDER);
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
    { status, headers: { "cache-control": "no-store" } },
  );
}
