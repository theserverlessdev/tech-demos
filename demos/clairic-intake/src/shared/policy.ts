import { DECISIONS, LIMITS, type Decision } from "./limits";
import { formatAnswer } from "./format";
import type { Answer } from "./types";

export const DECISION_CRITERIA: Record<Decision, string> = {
  refund: "Refund the amount paid when the note describes damage, the amount is present, and delivery was within 30 days.",
  escalate: "Send to a person when a value is null or confidence is under 0.8.",
  approve: "Approve when the extracted fields are present and the note does not describe damage.",
};

export function distributionConfidence(probabilities: Record<Decision, number>): number {
  const values = DECISIONS.map((key) => probabilities[key]);
  const max = Math.max(...values);
  const n = values.length;
  return Math.min(1, Math.max(0, (n * max - 1) / (n - 1)));
}

export function probabilitiesFor(choice: Decision): Record<Decision, number> {
  const out: Record<Decision, number> = { refund: 0.08, escalate: 0.08, approve: 0.08 };
  const others = DECISIONS.filter((key) => key !== choice);
  out[choice] = 0.8;
  out[others[0]] = 0.12;
  out[others[1]] = 0.08;
  return out;
}

/** Clef sees typed values only. The raw document is not part of this string. The policy stays at the front so a long value list cannot cut it off. */
export function decisionState(answers: Record<string, Answer>): string {
  const policy = "Policy: refund damage within 30 days when the amount is known. Escalate nulls and low confidence. Otherwise approve.";
  const lines = Object.entries(answers).map(([name, answer]) => `${name}: ${formatAnswer(answer)}`);
  const body = `Extracted intake values:\n${lines.join("\n")}`;
  const head = `${policy}\n`;
  return head + body.slice(0, Math.max(0, 2000 - head.length));
}

export function chooseFromAnswers(answers: Record<string, { value: unknown; confidence?: number }>): Decision {
  const damage = answers.damage?.value;
  const hasDamage = Array.isArray(damage) && damage.length > 0;
  const amount = [answers.amount_paid?.value, answers.total?.value, answers.loss_amount?.value].find((value) => typeof value === "number");
  const days = answers.days_since_delivery?.value;
  const recent = typeof days !== "number" || days <= 30;
  if (hasDamage && typeof amount === "number" && recent) return "refund";
  const uncertain = Object.values(answers).some((answer) => answer.value === null || answer.value === undefined || (typeof answer.confidence === "number" && answer.confidence < LIMITS.reviewConfidence));
  if (uncertain) return "escalate";
  return "approve";
}
