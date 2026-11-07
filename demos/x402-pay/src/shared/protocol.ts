/** Public path on the hub zone. The subdomain serves the same Worker at `/`. */
export const BASE_PATH = "/demos/x402-pay";

export const DEMO_HOST = "x402-pay.tech-demos.theserverless.dev";
export const HUB_HOST = "tech-demos.theserverless.dev";

/** Siteverify action for the shared widget. At most 32 characters. */
export const TURNSTILE_ACTION = "x402-pay";

/** CAIP-2 for Base Sepolia. Legacy names such as `base-sepolia` are not accepted. */
export const NETWORK = "eip155:84532";
export const NETWORK_LABEL = "Base Sepolia";
export const CHAIN_ID = 84532;

/** Circle's Base Sepolia test USDC. Six decimals. */
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
/** Circle's Base mainnet USDC. Rejected. */
export const USDC_BASE_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const USDC_NAME = "USDC";
export const USDC_VERSION = "2";

/** Public stand-in used only while mock mode is on. It is not a funded wallet. */
export const MOCK_PAYEE = "0x0000000000000000000000000000000000000402";

export const FACILITATOR_URL = "https://x402.org/facilitator";

export const SQUARE_ATOMIC = "10000";
export const SUMMARY_ATOMIC = "20000";
export const MAX_PAYMENT_ATOMIC = 20000n;

export const CONFIRM_TTL_MS = 2 * 60 * 1000;
export const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
export const BUSY_MS = 45 * 1000;

export const SESSION_PAID_CAP = 6;
export const GLOBAL_PAID_CAP = 40;
export const SESSION_FREE_CAP = 30;

export const MAX_ECHO = 280;
export const MAX_SUMMARY_IN = 1500;
export const MAX_SUMMARY_OUT = 500;
export const MAX_SQUARE = 1_000_000;
export const MAX_BODY_BYTES = 8192;

export const MOCK_LABEL = "Mock settlement. Not a Base Sepolia payment.";
export const PENDING_LABEL = "Setup pending. The testnet payee and signing key are not set. No charge was made.";
export const UNKNOWN_LABEL = "Outcome unknown. It may have settled on Base Sepolia. Not retried.";

export type ToolName = "echo" | "square" | "summarize";
export type Mode = "pending" | "mock" | "testnet";
export type LedgerStatus = "requested" | "approved" | "settled" | "failed" | "denied" | "unknown";

export type CanonicalArgs = Record<string, string | number>;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export function isToolName(value: string): value is ToolName {
  return value === "echo" || value === "square" || value === "summarize";
}

export function isPaid(tool: ToolName): boolean {
  return tool !== "echo";
}

export function priceOf(tool: ToolName): string | null {
  if (tool === "square") return SQUARE_ATOMIC;
  if (tool === "summarize") return SUMMARY_ATOMIC;
  return null;
}

export function amountLabel(atomic: string): string {
  if (atomic === SQUARE_ATOMIC) return "$0.01";
  if (atomic === SUMMARY_ATOMIC) return "$0.02";
  return "unsupported";
}

export function isAddress(value: string): value is `0x${string}` {
  return ADDRESS.test(value);
}

export function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function isPrivateKey(value: string | undefined): value is `0x${string}` {
  return typeof value === "string" && PRIVATE_KEY.test(value);
}

export function isTestnetTx(value: string): boolean {
  return TX_HASH.test(value);
}

export function isMockTx(value: string): boolean {
  return /^mock:[0-9a-f]{16}$/.test(value);
}

export function parseArgs(tool: string, raw: unknown): { tool: ToolName; args: CanonicalArgs } | { error: string } {
  if (!isToolName(tool)) return { error: "Unknown tool." };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Arguments must be an object." };
  const body = raw as Record<string, unknown>;
  if (tool === "echo") {
    const message = body.message;
    if (typeof message !== "string" || message.length === 0 || message.length > MAX_ECHO) {
      return { error: `Echo needs a message of 1 to ${MAX_ECHO} characters.` };
    }
    return { tool, args: { message } };
  }
  if (tool === "square") {
    const number = body.number;
    if (typeof number !== "number" || !Number.isFinite(number) || Math.abs(number) > MAX_SQUARE) {
      return { error: `Square needs a finite number between -${MAX_SQUARE} and ${MAX_SQUARE}.` };
    }
    return { tool, args: { number } };
  }
  const text = body.text;
  if (typeof text !== "string" || text.trim().length === 0 || text.length > MAX_SUMMARY_IN) {
    return { error: `Summarize needs text of 1 to ${MAX_SUMMARY_IN} characters.` };
  }
  return { tool, args: { text } };
}

export function bindingMaterial(input: {
  tool: ToolName;
  args: CanonicalArgs;
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
}): string {
  return JSON.stringify({
    amount: input.amount,
    args: input.args,
    asset: input.asset.toLowerCase(),
    network: input.network,
    payTo: input.payTo.toLowerCase(),
    scheme: input.scheme,
    tool: input.tool,
  });
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function sameString(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomId(bytes = 16): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return [...data].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(): string {
  const data = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function clientBase(pathname: string): string {
  if (pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`)) return BASE_PATH;
  return "";
}
