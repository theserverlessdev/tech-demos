import { PRICES } from "./limits";
import type { Usage } from "./types";

export function clairicUsd(inputTokens: number): number {
  return (Math.max(0, inputTokens) / 1_000_000) * PRICES.clairicPerMInput;
}

export function llamaUsd(inputTokens: number, outputTokens: number): number {
  return (Math.max(0, inputTokens) / 1_000_000) * PRICES.llamaPerMInput + (Math.max(0, outputTokens) / 1_000_000) * PRICES.llamaPerMOutput;
}

export function clefUsd(inputTokens: number): number {
  return (Math.max(0, inputTokens) / 1_000_000) * PRICES.clefPerMInput;
}

export function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(Math.max(0, chars) / 4));
}

export function usageFromChars(stateChars: number, schemaChars: number, outputChars = 0): Usage {
  const state_tokens = estimateTokens(stateChars);
  const schema_tokens = estimateTokens(schemaChars);
  return {
    state_tokens,
    image_tokens: 0,
    schema_tokens,
    input_tokens: state_tokens + schema_tokens,
    output_tokens: outputChars ? estimateTokens(outputChars) : 0,
    passes: 1,
  };
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.0001) return `$${value.toExponential(1)}`;
  return `$${value.toFixed(value < 0.01 ? 5 : 4)}`;
}
