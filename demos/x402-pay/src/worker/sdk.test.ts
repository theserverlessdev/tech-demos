import { createServer } from "node:http";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withX402, withX402Client } from "agents/x402";
import { toClientEvmSigner } from "@x402/evm";
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { FACILITATOR_URL, MOCK_PAYEE, NETWORK, SQUARE_ATOMIC, isPrivateKey, isTestnetTx } from "../shared/protocol";
import { guardPayment } from "./guard";
import { interpretPay, viewToolResult } from "./interpret";
import { mockFacilitatorResponse, memoryStore } from "./mock-facilitator";
import { usableTestnetPayee } from "./policy";
import type { Sql } from "./sql";

const migration = readFileSync(new URL("../../migrations/0001_ledger.sql", import.meta.url), "utf8");

function memory(): Sql {
  const db = new Database(":memory:");
  db.exec(migration);
  return {
    async run(query, params = []) {
      return Number(db.query(query).run(...(params as never[])).changes ?? 0);
    },
    async get<T extends Record<string, unknown>>(query, params = []) {
      return (db.query(query).get(...(params as never[])) as T | null) ?? null;
    },
    async all<T extends Record<string, unknown>>(query, params = []) {
      return db.query(query).all(...(params as never[])) as T[];
    },
  };
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve(address.port);
    });
  });
}

test("paidTool challenges, rejects a bad payment, settles once, and a replay does not settle again", async () => {
  const store = memoryStore();
  let settles = 0;
  const wrapped = {
    get: (fingerprint: string) => store.get(fingerprint),
    put: async (fingerprint: string, tx: string) => {
      const existing = await store.get(fingerprint);
      if (existing) return existing;
      settles += 1;
      return store.put(fingerprint, tx);
    },
  };
  let lastPayload: unknown = null;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    if (body) {
      try {
        const parsed = JSON.parse(body) as { paymentPayload?: unknown };
        if (parsed.paymentPayload) lastPayload = parsed.paymentPayload;
      } catch {
        // The supported call has no body.
      }
    }
    const request = new Request(`http://127.0.0.1${req.url ?? "/"}`, {
      method: req.method,
      headers: { "content-type": "application/json" },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    const response = await mockFacilitatorResponse(request, wrapped);
    const text = response ? await response.text() : "";
    res.writeHead(response?.status ?? 404, { "content-type": "application/json" });
    res.end(text);
  });
  const port = await listen(server);
  let executions = 0;
  const sql = memory();
  try {
    const mcp = withX402(new McpServer({ name: "PayMCP", version: "1.0.0" }), {
      network: NETWORK,
      recipient: MOCK_PAYEE,
      facilitator: { url: `http://127.0.0.1:${port}/internal/mock-facilitator` },
    });
    mcp.paidTool("square", "Squares a number", 0.01, { number: z.number() }, {}, async (args, extra) =>
      guardPayment({
        sql,
        tool: "square",
        amount: SQUARE_ATOMIC,
        payee: MOCK_PAYEE,
        extra,
        now: Date.now(),
        run: async () => {
          executions += 1;
          return { content: [{ type: "text", text: String(Number(args.number) ** 2) }] };
        },
      }),
    );
    mcp.registerTool("echo", { description: "Echo", inputSchema: { message: z.string() } }, async ({ message }) => ({
      content: [{ type: "text", text: String(message) }],
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    const client = new Client({ name: "pay-agent", version: "1.0.0" });
    await client.connect(clientTransport);

    const free = await client.callTool({ name: "echo", arguments: { message: "hi" } });
    expect(free.isError).toBeFalsy();
    expect(executions).toBe(0);

    const unpaid = await client.callTool({ name: "square", arguments: { number: 6 } });
    expect(unpaid.isError).toBe(true);
    const meta = unpaid._meta as { "x402/error"?: { accepts?: { amount?: string; network?: string }[] } } | undefined;
    expect(meta?.["x402/error"]?.accepts?.[0]?.network).toBe(NETWORK);
    expect(meta?.["x402/error"]?.accepts?.[0]?.amount).toBe(SQUARE_ATOMIC);
    expect(executions).toBe(0);
    expect(settles).toBe(0);

    const account = privateKeyToAccount(generatePrivateKey());
    const rawCall = client.callTool.bind(client);
    const payer = withX402Client(client, {
      network: NETWORK,
      account: toClientEvmSigner(account),
      maxPaymentValue: 20000n,
    });
    const paid = await payer.callTool(async () => true, { name: "square", arguments: { number: 6 } });
    expect(paid.isError).toBeFalsy();
    const paidText = paid.content?.[0] && "text" in paid.content[0] ? paid.content[0].text : "";
    expect(paidText).toBe("36");
    expect(executions).toBe(1);
    expect(settles).toBe(1);
    const receipt = (paid._meta as { "x402/payment-response"?: { transaction?: string } } | undefined)?.["x402/payment-response"];
    expect(receipt?.transaction?.startsWith("mock:")).toBe(true);

    const payload = lastPayload as { payload?: { signature?: string } };
    expect(typeof payload.payload?.signature).toBe("string");
    const replay = await rawCall({
      name: "square",
      arguments: { number: 6 },
      _meta: { "x402/payment": btoa(JSON.stringify(payload)) },
    });
    expect(replay.isError).toBe(true);
    expect(executions).toBe(1);
    expect(settles).toBe(1);

    const forged = structuredClone(payload) as { accepted?: { network?: string }; payload?: { signature?: string } };
    if (forged.accepted) forged.accepted.network = "eip155:8453";
    if (forged.payload) forged.payload.signature = `0x${"11".repeat(65)}`;
    const wrongChain = await rawCall({
      name: "square",
      arguments: { number: 6 },
      _meta: { "x402/payment": btoa(JSON.stringify(forged)) },
    });
    expect(wrongChain.isError).toBe(true);
    expect(executions).toBe(1);
    expect(settles).toBe(1);

    const twin = structuredClone(payload) as { payload?: { signature?: string } };
    const original = twin.payload?.signature;
    if (!original || !twin.payload) throw new Error("the settled payment had no signature");
    twin.payload.signature = malleableSignature(original);
    expect(twin.payload.signature).not.toBe(original);
    const malleableReplay = await rawCall({
      name: "square",
      arguments: { number: 6 },
      _meta: { "x402/payment": btoa(JSON.stringify(twin)) },
    });
    expect(malleableReplay.isError).toBe(true);
    const replayCode = (malleableReplay._meta as { "x402-pay/code"?: string } | undefined)?.["x402-pay/code"];
    expect(replayCode).toBe("replay");
    expect(executions).toBe(1);
    expect(settles).toBe(1);
  } finally {
    server.close();
  }
});

function malleableSignature(signature: string): string {
  const hex = signature.slice(2);
  const r = hex.slice(0, 64);
  const s = BigInt(`0x${hex.slice(64, 128)}`);
  const v = Number.parseInt(hex.slice(128, 130), 16);
  const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const nextS = (order - s).toString(16).padStart(64, "0");
  // viem emits v as 27 or 28. The malleable twin flips that pair. v xor 1 would make 27 into 26, which is not a recovery id.
  const nextV = v === 27 ? 28 : v === 28 ? 27 : v ^ 1;
  return `0x${r}${nextS}${nextV.toString(16).padStart(2, "0")}`;
}

test("a facilitator settle of success false does not attach a receipt or sign again", async () => {
  let verifies = 0;
  let executions = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = req.url ?? "/";
    if (url.includes("/settle")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, errorReason: "facilitator_rejected", transaction: "", network: NETWORK }));
      return;
    }
    if (url.includes("/verify")) verifies += 1;
    const request = new Request(`http://127.0.0.1${url}`, {
      method: req.method,
      headers: { "content-type": "application/json" },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    const response = await mockFacilitatorResponse(request, memoryStore());
    const text = response ? await response.text() : "";
    res.writeHead(response?.status ?? 404, { "content-type": "application/json" });
    res.end(text);
  });
  const port = await listen(server);
  try {
    const mcp = withX402(new McpServer({ name: "PayMCP", version: "1.0.0" }), {
      network: NETWORK,
      recipient: MOCK_PAYEE,
      facilitator: { url: `http://127.0.0.1:${port}/internal/mock-facilitator` },
    });
    mcp.paidTool("square", "Squares a number", 0.01, { number: z.number() }, {}, async (args, extra) =>
      guardPayment({
        sql: memory(),
        tool: "square",
        amount: SQUARE_ATOMIC,
        payee: MOCK_PAYEE,
        extra,
        now: Date.now(),
        run: async () => {
          executions += 1;
          return { content: [{ type: "text", text: String(Number(args.number) ** 2) }] };
        },
      }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    const client = new Client({ name: "pay-agent", version: "1.0.0" });
    await client.connect(clientTransport);
    const rawCall = client.callTool.bind(client);
    const payer = withX402Client(client, {
      network: NETWORK,
      account: toClientEvmSigner(privateKeyToAccount(generatePrivateKey())),
      maxPaymentValue: 20000n,
    });
    const paid = await payer.callTool(async () => true, { name: "square", arguments: { number: 3 } });
    expect(paid.isError).toBe(true);
    const meta = paid._meta as Record<string, unknown> | undefined;
    expect(meta?.["x402/payment-response"]).toBeUndefined();
    expect(executions).toBeLessThanOrEqual(1);
    expect(verifies).toBe(1);
    expect(interpretPay("mock", viewToolResult(paid)).kind).toBe("failed");
    const second = await rawCall({ name: "square", arguments: { number: 3 } });
    expect(second.isError).toBe(true);
    expect(verifies).toBe(1);
  } finally {
    server.close();
  }
});

test.skipIf(process.env.X402_LIVE_TEST !== "1")("settles one square call on Base Sepolia", async () => {
  const payee = process.env.X402_PAYEE_ADDRESS ?? "";
  const key = process.env.X402_CLIENT_PRIVATE_KEY ?? "";
  if (!usableTestnetPayee(payee) || !isPrivateKey(key)) {
    throw new Error("X402_LIVE_TEST=1 needs X402_PAYEE_ADDRESS and X402_CLIENT_PRIVATE_KEY. No receipt was invented.");
  }
  const sql = memory();
  const mcp = withX402(new McpServer({ name: "PayMCP", version: "1.0.0" }), {
    network: NETWORK,
    recipient: payee,
    facilitator: { url: FACILITATOR_URL },
  });
  mcp.paidTool("square", "Squares a number", 0.01, { number: z.number() }, {}, async (args, extra) =>
    guardPayment({
      sql,
      tool: "square",
      amount: SQUARE_ATOMIC,
      payee,
      extra,
      now: Date.now(),
      run: async () => ({ content: [{ type: "text", text: String(Number(args.number) ** 2) }] }),
    }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  const client = new Client({ name: "pay-agent", version: "1.0.0" });
  await client.connect(clientTransport);
  const payer = withX402Client(client, {
    network: NETWORK,
    account: toClientEvmSigner(privateKeyToAccount(key)),
    maxPaymentValue: 20000n,
  });
  const paid = await payer.callTool(async () => true, { name: "square", arguments: { number: 7 } });
  const receipt = (paid._meta as { "x402/payment-response"?: { success?: boolean; transaction?: string; network?: string } } | undefined)?.["x402/payment-response"];
  const text = paid.content?.[0] && "text" in paid.content[0] ? paid.content[0].text : "";
  if (paid.isError || !receipt?.success || receipt.network !== NETWORK || !isTestnetTx(receipt.transaction ?? "") || text !== "49") {
    throw new Error("Base Sepolia settlement did not return a transaction hash. Nothing was marked paid.");
  }
});
