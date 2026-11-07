import { priceOf, sha256Hex } from "../shared/protocol";
import { claimFingerprint, finishFingerprint } from "./ledger";
import { assessPayload, boundFor, signatureMatches, type PaymentPayload } from "./policy";
import type { Sql } from "./sql";

export type ToolResult = {
  isError?: boolean;
  content: { type: "text"; text: string }[];
  _meta?: Record<string, unknown>;
};

function textResult(text: string, code: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }], _meta: { "x402-pay/code": code } };
}

function readToken(extra: unknown): string | null {
  if (!extra || typeof extra !== "object") return null;
  const row = extra as Record<string, unknown>;
  const metas = [row._meta];
  const nested = row.mcpReq;
  if (nested && typeof nested === "object") metas.push((nested as Record<string, unknown>)._meta);
  for (const meta of metas) {
    if (!meta || typeof meta !== "object") continue;
    const token = (meta as Record<string, unknown>)["x402/payment"];
    if (typeof token === "string") return token;
  }
  return null;
}

function decodePayload(token: string): PaymentPayload | null {
  try {
    const parsed = JSON.parse(atob(token)) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as PaymentPayload;
  } catch {
    return null;
  }
}

/**
 * Runs the tool only after the payload matches the catalog and the signature checks out.
 * Returning an error keeps the SDK from settling. A repeated signature does not run again.
 */
export async function guardPayment(opts: {
  sql: Sql;
  tool: "square" | "summarize";
  amount: string;
  payee: string;
  extra: unknown;
  now: number;
  run: () => Promise<ToolResult>;
}): Promise<ToolResult> {
  if (priceOf(opts.tool) !== opts.amount) return textResult("The tool price is not configured.", "wrong_amount");
  const token = readToken(opts.extra);
  if (!token) return textResult("A payment is required.", "unsigned");
  const payload = decodePayload(token);
  if (!payload) return textResult("The payment could not be read.", "malformed");
  const decision = assessPayload(payload, boundFor(opts.tool, opts.payee, opts.amount), Math.floor(opts.now / 1000));
  if (!decision.ok) return textResult(decision.message, decision.code);
  if (!(await signatureMatches(payload))) return textResult("The payment signature does not match Base Sepolia.", "unsigned");
  const signature = payload.payload?.signature;
  if (typeof signature !== "string") return textResult("The payment has no usable signature.", "unsigned");
  const fingerprint = await sha256Hex(signature);
  const claim = await claimFingerprint(opts.sql, fingerprint, opts.now);
  if (claim !== "new") return textResult("This payment was already used. It was not settled again.", claim === "replay" ? "replay" : "failed");
  try {
    const result = await opts.run();
    await finishFingerprint(opts.sql, fingerprint, result.isError ? "failed" : "executed");
    return result;
  } catch {
    await finishFingerprint(opts.sql, fingerprint, "failed");
    return textResult("The tool failed. Nothing is marked paid.", "tool_failed");
  }
}
