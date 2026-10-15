/** Join fragments into one sentence, without a doubled period. */
export function joinSentences(...parts: string[]): string {
  const cleaned = parts.map((part) => part.replace(/[.]+$/g, "").trim()).filter(Boolean);
  if (cleaned.length === 0) return "";
  return `${cleaned.join(". ")}.`;
}
