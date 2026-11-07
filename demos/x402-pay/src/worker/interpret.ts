import { MOCK_LABEL, NETWORK, PENDING_LABEL, isMockTx, isTestnetTx, type Mode } from "../shared/protocol";

export type ToolView = {
  text: string;
  isError: boolean;
  setup: boolean;
  challenge: Record<string, unknown> | null;
  success: boolean;
  transaction: string;
  network: string;
  code: string;
};

export type PayView =
  | { kind: "result"; text: string }
  | { kind: "challenge"; requirement: Record<string, unknown> }
  | { kind: "setup_pending"; message: string }
  | { kind: "failed"; code: string; message: string }
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
  return {
    text,
    isError: body.isError === true,
    setup,
    challenge,
    success,
    transaction,
    network,
    code,
  };
}

/**
 * `paid` is true only for a testnet settlement with a real transaction hash.
 * A mock receipt stays unpaid. A testnet response that carries a mock id is a failure.
 */
export function interpretPay(mode: Mode, view: ToolView): PayView {
  if (view.setup) return { kind: "setup_pending", message: PENDING_LABEL };
  if (view.challenge) return { kind: "challenge", requirement: view.challenge };
  if (view.isError || !view.success) {
    return { kind: "failed", code: view.code || "not_settled", message: view.text || "The payment did not settle. Nothing is marked paid." };
  }
  if (mode === "testnet" && view.network === NETWORK && isTestnetTx(view.transaction)) {
    return { kind: "settled", settlement: "testnet", paid: true, transaction: view.transaction, text: view.text, label: "Settled on Base Sepolia test USDC." };
  }
  if (mode === "mock" && view.network === NETWORK && isMockTx(view.transaction)) {
    return { kind: "settled", settlement: "mock", paid: false, transaction: view.transaction, text: view.text, label: MOCK_LABEL };
  }
  return { kind: "failed", code: "not_settled", message: "The receipt did not match Base Sepolia. Nothing is marked paid." };
}
