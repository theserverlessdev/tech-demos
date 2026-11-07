import { MOCK_LABEL, NETWORK, PENDING_LABEL, UNKNOWN_LABEL, isMockTx, isTestnetTx, type Mode } from "../shared/protocol";

export type ToolView = {
  text: string;
  isError: boolean;
  setup: boolean;
  challenge: Record<string, unknown> | null;
  success: boolean;
  transaction: string;
  network: string;
  code: string;
  reason: string;
};

export type PayView =
  | { kind: "result"; text: string }
  | { kind: "challenge"; requirement: Record<string, unknown> }
  | { kind: "setup_pending"; message: string }
  | { kind: "failed"; code: string; message: string }
  | { kind: "unknown"; message: string }
  | { kind: "settled"; settlement: "testnet" | "mock"; paid: boolean; transaction: string; text: string; label: string };

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function viewToolResult(raw: unknown): ToolView {
  const body = record(raw) ?? {};
  const content = Array.isArray(body.content) ? body.content : [];
  const first = record(content[0]);
  const text = first && first.type === "text" && typeof first.text === "string" ? first.text.slice(0, 2000) : "";
  const meta = record(body._meta) ?? {};
  const setup = meta["x402-pay/setup"] === "pending";
  const error = record(meta["x402/error"]);
  const accepts = error && Array.isArray(error.accepts) ? error.accepts : [];
  const challenge = record(accepts[0]);
  const receipt = record(meta["x402/payment-response"]);
  const transaction = receipt && typeof receipt.transaction === "string" ? receipt.transaction : "";
  const network = receipt && typeof receipt.network === "string" ? receipt.network : "";
  const success = receipt?.success === true;
  const code = typeof meta["x402-pay/code"] === "string" ? meta["x402-pay/code"] : "";
  const reason = error && typeof error.error === "string" ? error.error : "";
  return {
    text,
    isError: body.isError === true,
    setup,
    challenge,
    success,
    transaction,
    network,
    code,
    reason,
  };
}

const FAILED_MESSAGE = "The payment did not settle. Nothing is marked paid.";

/**
 * Used only after an owned pay. The quote probe reads `view.challenge` itself and does not call this.
 * `paid` is true only for a testnet settlement with a real transaction hash. A mock receipt stays unpaid.
 * Any payment-required result is unknown. agents@0.33.0 `dist/mcp/client/x402.js` line 189 returns
 * `paymentRequired(s.errorReason ?? "SETTLEMENT_FAILED")`, so the reason can be empty, `PAYMENT_REQUIRED`,
 * or `INVALID_PAYMENT` after settle may already have been submitted. The text is not evidence.
 * A handler failure has no payment-required payload: the SDK skips settle when the handler returns an error.
 */
export function interpretPay(mode: Mode, view: ToolView): PayView {
  if (view.setup) return { kind: "setup_pending", message: PENDING_LABEL };
  if (view.challenge) return { kind: "unknown", message: UNKNOWN_LABEL };
  if (view.success) {
    if (mode === "testnet" && view.network === NETWORK && isTestnetTx(view.transaction)) {
      return { kind: "settled", settlement: "testnet", paid: true, transaction: view.transaction, text: view.text, label: "Settled on Base Sepolia test USDC." };
    }
    if (mode === "mock" && view.network === NETWORK && isMockTx(view.transaction)) {
      return { kind: "settled", settlement: "mock", paid: false, transaction: view.transaction, text: view.text, label: MOCK_LABEL };
    }
    return { kind: "unknown", message: UNKNOWN_LABEL };
  }
  return { kind: "failed", code: view.code || "not_settled", message: safeFailureMessage(view.text) };
}

function safeFailureMessage(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("{") || trimmed.includes("\"accepts\"") || trimmed.includes("\"x402Version\"")) return FAILED_MESSAGE;
  return trimmed.slice(0, 180);
}
