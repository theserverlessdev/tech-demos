import { verifyTypedData } from "viem";
import {
  CHAIN_ID,
  MOCK_PAYEE,
  NETWORK,
  USDC_BASE_MAINNET,
  USDC_BASE_SEPOLIA,
  USDC_NAME,
  USDC_VERSION,
  isAddress,
  isPrivateKey,
  sameAddress,
  type ToolName,
} from "../shared/protocol";

const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const NONCE = /^0x[0-9a-fA-F]{64}$/;
const ZERO = "0x0000000000000000000000000000000000000000";

const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export type Decision = { ok: true } | { ok: false; code: string; message: string };

export type Requirement = {
  scheme?: unknown;
  network?: unknown;
  asset?: unknown;
  amount?: unknown;
  payTo?: unknown;
  maxTimeoutSeconds?: unknown;
  extra?: unknown;
};

export type PaymentPayload = {
  x402Version?: unknown;
  accepted?: Requirement;
  payload?: {
    authorization?: {
      from?: unknown;
      to?: unknown;
      value?: unknown;
      validAfter?: unknown;
      validBefore?: unknown;
      nonce?: unknown;
    };
    signature?: unknown;
  };
};

export type Bound = {
  tool: ToolName;
  scheme: "exact";
  network: typeof NETWORK;
  asset: string;
  amount: string;
  payTo: string;
};

function fail(code: string, message: string): Decision {
  return { ok: false, code, message };
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function payeeForMode(mode: "pending" | "mock" | "testnet", configured: string | undefined): string {
  if (mode === "mock") return MOCK_PAYEE;
  return configured ?? "";
}

/**
 * Mock mode is on only when the caller says local, the flag is mock, and the facilitator origin is loopback.
 * PayAgent and PayMCP pass local from LOCAL_DEV alone. The session API is what refuses a public host that still has those vars set.
 */
export function resolveMode(opts: {
  local: boolean;
  modeFlag: string | undefined;
  facilitatorOrigin: string | undefined;
  payee: string | undefined;
  privateKey: string | undefined;
}): "pending" | "mock" | "testnet" {
  if (opts.local && opts.modeFlag === "mock" && loopbackOrigin(opts.facilitatorOrigin)) return "mock";
  if (usableTestnetPayee(opts.payee) && isPrivateKey(opts.privateKey)) return "testnet";
  return "pending";
}

function httpOrigin(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function loopbackOrigin(value: string | undefined): boolean {
  if (!httpOrigin(value) || !value) return false;
  const host = new URL(value).hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export function usableTestnetPayee(value: string | undefined): value is `0x${string}` {
  if (!value || !isAddress(value)) return false;
  if (sameAddress(value, ZERO) || sameAddress(value, MOCK_PAYEE)) return false;
  return true;
}

/** Exactly one requirement, and it matches the bound the visitor confirmed. */
export function acceptsBound(requirements: unknown[], bound: Bound): boolean {
  if (requirements.length !== 1) return false;
  const row = record(requirements[0]);
  if (!row) return false;
  return assessRequirement(
    {
      scheme: row.scheme,
      network: row.network,
      asset: row.asset,
      amount: row.amount,
      payTo: row.payTo,
      maxTimeoutSeconds: row.maxTimeoutSeconds,
      extra: row.extra,
    },
    bound,
  ).ok;
}

export type CatalogCharge = { amount: string; payTo: string };

/**
 * The signer uses the confirmed row. It may sign only when that row is the catalog price and payee.
 * A mismatch returns before any key is loaded.
 */
export function signableCharge(
  row: CatalogCharge,
  catalog: CatalogCharge,
): { ok: true; amount: string; payTo: string } | { ok: false; code: "altered" } {
  if (row.amount !== catalog.amount || !sameAddress(row.payTo, catalog.payTo)) return { ok: false, code: "altered" };
  return { ok: true, amount: row.amount, payTo: row.payTo };
}

export function assessRequirement(req: Requirement, bound: Bound): Decision {
  if (req.scheme !== "exact") return fail("wrong_scheme", "Only the exact scheme is accepted.");
  if (req.network !== NETWORK) return fail("wrong_network", "Only Base Sepolia (eip155:84532) is accepted.");
  if (typeof req.asset !== "string" || !isAddress(req.asset)) return fail("wrong_asset", "The token address is missing.");
  if (sameAddress(req.asset, USDC_BASE_MAINNET)) return fail("wrong_asset", "Mainnet USDC is rejected.");
  if (!sameAddress(req.asset, USDC_BASE_SEPOLIA)) return fail("wrong_asset", "Only Base Sepolia test USDC is accepted.");
  if (req.amount !== bound.amount) return fail("wrong_amount", "The amount does not match the tool price.");
  if (typeof req.payTo !== "string" || !isAddress(req.payTo)) return fail("wrong_payee", "The payee is missing.");
  if (sameAddress(req.payTo, ZERO)) return fail("wrong_payee", "The zero address is rejected.");
  if (!sameAddress(req.payTo, bound.payTo)) return fail("wrong_payee", "The payee does not match this demo.");
  const extra = record(req.extra);
  if (!extra || extra.name !== USDC_NAME || extra.version !== USDC_VERSION) {
    return fail("wrong_domain", "The USDC name or version is not the Base Sepolia domain.");
  }
  const timeout = req.maxTimeoutSeconds;
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > 300) {
    return fail("bad_timeout", "The payment window must be between 1 and 300 seconds.");
  }
  return { ok: true };
}

export function assessPayload(payment: PaymentPayload, bound: Bound, nowSec: number): Decision {
  const accepted = payment.accepted;
  if (!accepted) return fail("malformed", "The payment is missing its accepted requirement.");
  const requirement = assessRequirement(accepted, bound);
  if (!requirement.ok) return requirement;
  const authorization = payment.payload?.authorization;
  const signature = payment.payload?.signature;
  if (!authorization || typeof signature !== "string" || !SIGNATURE.test(signature)) {
    return fail("unsigned", "The payment has no usable signature.");
  }
  if (typeof authorization.from !== "string" || !isAddress(authorization.from)) {
    return fail("malformed", "The payer address is missing.");
  }
  if (typeof authorization.to !== "string" || !sameAddress(authorization.to, bound.payTo)) {
    return fail("altered", "The signed payee does not match the challenge.");
  }
  if (authorization.value !== bound.amount) return fail("altered", "The signed amount does not match the challenge.");
  if (typeof authorization.nonce !== "string" || !NONCE.test(authorization.nonce)) {
    return fail("malformed", "The payment nonce is missing.");
  }
  const validAfter = typeof authorization.validAfter === "string" ? Number(authorization.validAfter) : Number.NaN;
  const validBefore = typeof authorization.validBefore === "string" ? Number(authorization.validBefore) : Number.NaN;
  if (!Number.isSafeInteger(validAfter) || !Number.isSafeInteger(validBefore)) {
    return fail("malformed", "The payment window is not a whole number of seconds.");
  }
  if (validAfter > nowSec + 60) return fail("not_yet_valid", "The payment is not valid yet.");
  if (validBefore <= nowSec) return fail("expired", "The payment authorization has expired.");
  if (validBefore > nowSec + 360) return fail("bad_window", "The payment window is longer than this demo allows.");
  return { ok: true };
}

/** Recovers against chain id 84532 only. A signature for another chain does not match. */
export async function signatureMatches(payment: PaymentPayload): Promise<boolean> {
  const authorization = payment.payload?.authorization;
  const signature = payment.payload?.signature;
  const asset = payment.accepted?.asset;
  if (!authorization || typeof signature !== "string" || typeof asset !== "string") return false;
  if (typeof authorization.from !== "string" || typeof authorization.to !== "string") return false;
  if (typeof authorization.value !== "string" || typeof authorization.nonce !== "string") return false;
  if (typeof authorization.validAfter !== "string" || typeof authorization.validBefore !== "string") return false;
  try {
    return await verifyTypedData({
      address: authorization.from as `0x${string}`,
      domain: {
        name: USDC_NAME,
        version: USDC_VERSION,
        chainId: CHAIN_ID,
        verifyingContract: asset as `0x${string}`,
      },
      types: AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from as `0x${string}`,
        to: authorization.to as `0x${string}`,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce as `0x${string}`,
      },
      signature: signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}

export function boundFor(tool: ToolName, payee: string, amount: string): Bound {
  return { tool, scheme: "exact", network: NETWORK, asset: USDC_BASE_SEPOLIA, amount, payTo: payee };
}
