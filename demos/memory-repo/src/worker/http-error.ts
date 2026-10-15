import { isMeterMissingError } from "./budget";

export function safeApiMessage(err: unknown, fallback: string): string {
  const text = err instanceof Error ? err.message : fallback;
  if (
    text.startsWith("This browser reached") ||
    text.startsWith("The demo reached") ||
    text.startsWith("Workers AI did not answer") ||
    text.startsWith("Messages are limited") ||
    text.startsWith("Memory changed during") ||
    text.startsWith("The AI budget")
  ) {
    return text;
  }
  return fallback;
}

/** Chat failures that are budget or missing-meter stay 429/503, never a generic 502. */
export function chatFailure(err: unknown): { status: number; code: string; message: string } {
  const fallback = "The chat turn failed.";
  const text = err instanceof Error ? err.message : fallback;
  const message = safeApiMessage(err, fallback);
  if (text.includes("daily AI")) return { status: 429, code: "budget", message };
  if (isMeterMissingError(err) || text.startsWith("The AI budget")) return { status: 503, code: "meter", message };
  if (text.includes("Workers AI")) return { status: 503, code: "chat", message };
  return { status: 502, code: "chat", message };
}
