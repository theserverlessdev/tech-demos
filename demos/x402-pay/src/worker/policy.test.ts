import { expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  CHAIN_ID,
  MOCK_PAYEE,
  NETWORK,
  SQUARE_ATOMIC,
  USDC_BASE_MAINNET,
  USDC_BASE_SEPOLIA,
  USDC_NAME,
  USDC_VERSION,
} from "../shared/protocol";
import { acceptsBound, assessPayload, assessRequirement, boundFor, resolveMode, signableCharge, signatureMatches, usableTestnetPayee, type PaymentPayload, type Requirement } from "./policy";

const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const NOW = 1_700_000_000;

async function signed(overrides: Partial<Requirement> = {}, authOverrides: Record<string, string> = {}): Promise<PaymentPayload> {
  const account = privateKeyToAccount(generatePrivateKey());
  const payee = typeof overrides.payTo === "string" ? overrides.payTo : "0x2222222222222222222222222222222222222222";
  const amount = typeof overrides.amount === "string" ? overrides.amount : SQUARE_ATOMIC;
  const asset = typeof overrides.asset === "string" ? overrides.asset : USDC_BASE_SEPOLIA;
  const authorization = {
    from: account.address,
    to: payee,
    value: amount,
    validAfter: "0",
    validBefore: String(NOW + 120),
    nonce: `0x${"ab".repeat(32)}`,
    ...authOverrides,
  };
  const signature = await account.signTypedData({
    domain: { name: USDC_NAME, version: USDC_VERSION, chainId: CHAIN_ID, verifyingContract: asset as `0x${string}` },
    types: TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from as `0x${string}`,
      to: authorization.to as `0x${string}`,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce as `0x${string}`,
    },
  });
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: NETWORK,
      asset,
      amount,
      payTo: payee,
      maxTimeoutSeconds: 120,
      extra: { name: USDC_NAME, version: USDC_VERSION },
      ...overrides,
    },
    payload: { authorization, signature },
  };
}

const payee = "0x2222222222222222222222222222222222222222";

test("a Base Sepolia signature for the catalog price is accepted", async () => {
  const payment = await signed();
  const bound = boundFor("square", payee, SQUARE_ATOMIC);
  expect(assessRequirement(payment.accepted ?? {}, bound).ok).toBe(true);
  expect(assessPayload(payment, bound, NOW).ok).toBe(true);
  expect(await signatureMatches(payment)).toBe(true);
});

test("mainnet network, legacy alias, and mainnet USDC are rejected", async () => {
  const bound = boundFor("square", payee, SQUARE_ATOMIC);
  for (const network of ["eip155:8453", "eip155:1", "base", "base-sepolia", "ethereum"]) {
    const payment = await signed({ network });
    const decision = assessPayload(payment, bound, NOW);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.code).toBe("wrong_network");
  }
  const mainnetAsset = await signed({ asset: USDC_BASE_MAINNET });
  const assetDecision = assessPayload(mainnetAsset, bound, NOW);
  expect(assetDecision.ok).toBe(false);
  if (!assetDecision.ok) expect(assetDecision.code).toBe("wrong_asset");
});

test("unsigned, expired, and altered payments are rejected", async () => {
  const bound = boundFor("square", payee, SQUARE_ATOMIC);
  const missing = await signed();
  missing.payload = { authorization: missing.payload?.authorization, signature: "0x1234" };
  const unsigned = assessPayload(missing, bound, NOW);
  expect(unsigned.ok).toBe(false);
  if (!unsigned.ok) expect(unsigned.code).toBe("unsigned");

  const expired = await signed({}, { validBefore: String(NOW - 5) });
  const expiredDecision = assessPayload(expired, bound, NOW);
  expect(expiredDecision.ok).toBe(false);
  if (!expiredDecision.ok) expect(expiredDecision.code).toBe("expired");

  const altered = await signed();
  if (altered.payload?.authorization) altered.payload.authorization.value = "1";
  const alteredDecision = assessPayload(altered, bound, NOW);
  expect(alteredDecision.ok).toBe(false);
  if (!alteredDecision.ok) expect(alteredDecision.code).toBe("altered");
  expect(await signatureMatches(altered)).toBe(false);
});

test("a different payee or amount does not match the confirm", async () => {
  const bound = boundFor("square", payee, SQUARE_ATOMIC);
  const otherPayee = await signed({ payTo: "0x3333333333333333333333333333333333333333" });
  const payeeDecision = assessPayload(otherPayee, bound, NOW);
  expect(payeeDecision.ok).toBe(false);
  if (!payeeDecision.ok) expect(payeeDecision.code).toBe("wrong_payee");
  const otherAmount = await signed({ amount: "20000" });
  const amountDecision = assessPayload(otherAmount, bound, NOW);
  expect(amountDecision.ok).toBe(false);
  if (!amountDecision.ok) expect(amountDecision.code).toBe("wrong_amount");
});

test("mock mode cannot be selected on a public host or against a public facilitator", () => {
  expect(usableTestnetPayee(MOCK_PAYEE)).toBe(false);
  expect(usableTestnetPayee("0x0000000000000000000000000000000000000000")).toBe(false);
  expect(usableTestnetPayee(payee)).toBe(true);
  expect(resolveMode({ local: false, modeFlag: "mock", facilitatorOrigin: "http://127.0.0.1:8796", payee, privateKey: `0x${"ab".repeat(32)}` })).toBe("testnet");
  expect(resolveMode({ local: true, modeFlag: "mock", facilitatorOrigin: "https://x402.org/facilitator", payee: undefined, privateKey: undefined })).toBe("pending");
  expect(resolveMode({ local: true, modeFlag: "mock", facilitatorOrigin: "http://127.0.0.1:8796", payee: undefined, privateKey: undefined })).toBe("mock");
  expect(resolveMode({ local: false, modeFlag: undefined, facilitatorOrigin: undefined, payee: undefined, privateKey: undefined })).toBe("pending");
});

function oneRequirement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: USDC_BASE_SEPOLIA,
    amount: SQUARE_ATOMIC,
    payTo: payee,
    maxTimeoutSeconds: 60,
    extra: { name: USDC_NAME, version: USDC_VERSION },
    ...overrides,
  };
}

test("acceptsBound allows one exact Base Sepolia requirement and rejects the rest", () => {
  const bound = boundFor("square", payee, SQUARE_ATOMIC);
  expect(acceptsBound([oneRequirement(), oneRequirement()], bound)).toBe(false);
  expect(acceptsBound([oneRequirement({ network: "eip155:8453" })], bound)).toBe(false);
  expect(acceptsBound([oneRequirement({ asset: USDC_BASE_MAINNET })], bound)).toBe(false);
  expect(acceptsBound([oneRequirement({ amount: "20000" })], bound)).toBe(false);
  expect(acceptsBound([oneRequirement({ payTo: "0x3333333333333333333333333333333333333333" })], bound)).toBe(false);
  expect(acceptsBound([oneRequirement()], bound)).toBe(true);
});

test("signableCharge rejects a confirmed payee or amount that is not the catalog", () => {
  const catalog = { amount: SQUARE_ATOMIC, payTo: payee };
  const otherPayee = signableCharge({ amount: SQUARE_ATOMIC, payTo: "0x3333333333333333333333333333333333333333" }, catalog);
  expect(otherPayee.ok).toBe(false);
  if (!otherPayee.ok) expect(otherPayee.code).toBe("altered");
  const otherAmount = signableCharge({ amount: "20000", payTo: payee }, catalog);
  expect(otherAmount.ok).toBe(false);
  const match = signableCharge({ amount: SQUARE_ATOMIC, payTo: payee }, catalog);
  expect(match).toEqual({ ok: true, amount: SQUARE_ATOMIC, payTo: payee });
});
