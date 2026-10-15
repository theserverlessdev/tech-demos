const PLACEHOLDER = "[redacted]";

/** Printable ASCII excluding space. API keys must match this on the client and the Worker. */
export const PRINTABLE_ASCII_KEY = /^[\x21-\x7E]+$/;

export function isPrintableAsciiKey(value: string): boolean {
  return PRINTABLE_ASCII_KEY.test(value);
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Drop oldest messages until `JSON.stringify(body)` fits in maxBytes. Keeps at least one message. */
export function dropOldestUntilFits<T extends { messages: unknown[] }>(body: T, maxBytes: number): T {
  const messages = [...body.messages];
  let next = { ...body, messages };
  while (messages.length > 1 && utf8ByteLength(JSON.stringify(next)) > maxBytes) {
    messages.shift();
    next = { ...body, messages: [...messages] };
  }
  return next;
}

/** Trim to max UTF-8 bytes without splitting a code point. */
export function trimUtf8(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && ((encoded[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end -= 1;
  return new TextDecoder().decode(encoded.slice(0, end));
}

/** Replace only the exact pasted key. Used on success bodies and the live transcript. */
export function redactExact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed.length < 4) continue;
    out = out.split(trimmed).join(PLACEHOLDER);
  }
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
