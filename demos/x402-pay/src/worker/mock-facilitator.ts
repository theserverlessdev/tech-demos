import { MOCK_PAYEE, NETWORK, SQUARE_ATOMIC, SUMMARY_ATOMIC, sha256Hex } from "../shared/protocol";
import { assessPayload, boundFor, signatureMatches, type PaymentPayload, type Requirement } from "./policy";

export type MockStore = {
  get(fingerprint: string): Promise<string | null>;
  put(fingerprint: string, tx: string): Promise<string>;
};

export function memoryStore(): MockStore {
  const rows = new Map<string, string>();
  return {
    async get(fingerprint) {
      return rows.get(fingerprint) ?? null;
    },
    async put(fingerprint, tx) {
      const existing = rows.get(fingerprint);
      if (existing) return existing;
      rows.set(fingerprint, tx);
      return tx;
    },
  };
}

type SettleCounter = { verifies: number; settles: number };

export function countingStore(store: MockStore = memoryStore()): MockStore & SettleCounter {
  const counter = { verifies: 0, settles: 0 };
  return {
    get verifies() {
      return counter.verifies;
    },
    set verifies(value: number) {
      counter.verifies = value;
    },
    get settles() {
      return counter.settles;
    },
    set settles(value: number) {
      counter.settles = value;
    },
    get: (fingerprint) => store.get(fingerprint),
    async put(fingerprint, tx) {
      const existing = await store.get(fingerprint);
      if (existing) return existing;
      counter.settles += 1;
      return store.put(fingerprint, tx);
    },
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function amountTool(amount: string): "square" | "summarize" | null {
  if (amount === SQUARE_ATOMIC) return "square";
  if (amount === SUMMARY_ATOMIC) return "summarize";
  return null;
}

async function check(body: unknown, nowSec: number): Promise<{ ok: true; fingerprint: string; payload: PaymentPayload } | { ok: false; reason: string }> {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const payload = record?.paymentPayload as PaymentPayload | undefined;
  const requirements = record?.paymentRequirements as Requirement | undefined;
  if (!payload?.accepted || !requirements) return { ok: false, reason: "malformed" };
  if (payload.accepted.amount !== requirements.amount || payload.accepted.network !== requirements.network || payload.accepted.payTo !== requirements.payTo || payload.accepted.asset !== requirements.asset) {
    return { ok: false, reason: "altered" };
  }
  const tool = typeof payload.accepted.amount === "string" ? amountTool(payload.accepted.amount) : null;
  if (!tool || typeof payload.accepted.amount !== "string") return { ok: false, reason: "wrong_amount" };
  const decision = assessPayload(payload, boundFor(tool, MOCK_PAYEE, payload.accepted.amount), nowSec);
  if (!decision.ok) return { ok: false, reason: decision.code };
  if (!(await signatureMatches(payload))) return { ok: false, reason: "unsigned" };
  const token = JSON.stringify(payload);
  return { ok: true, fingerprint: (await sha256Hex(token)).slice(0, 32), payload };
}

export async function mockFacilitatorResponse(request: Request, store: MockStore, now = Date.now()): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "");
  if (!path.endsWith("/internal/mock-facilitator/supported") && !path.endsWith("/internal/mock-facilitator/verify") && !path.endsWith("/internal/mock-facilitator/settle")) {
    return null;
  }
  if (path.endsWith("/supported")) {
    if (request.method !== "GET") return json({ error: "method" }, 405);
    return json({
      kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }],
      extensions: [],
      signers: {},
    });
  }
  if (request.method !== "POST") return json({ error: "method" }, 405);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const verdict = await check(body, Math.floor(now / 1000));
  if (path.endsWith("/verify")) {
    if (!verdict.ok) return json({ isValid: false, invalidReason: verdict.reason });
    return json({ isValid: true });
  }
  if (!verdict.ok) {
    return json({ success: false, errorReason: verdict.reason, transaction: "", network: NETWORK });
  }
  const existing = await store.get(verdict.fingerprint);
  const tx = existing ?? (await store.put(verdict.fingerprint, `mock:${verdict.fingerprint.slice(0, 16)}`));
  return json({ success: true, transaction: tx, network: NETWORK, payer: MOCK_PAYEE });
}
