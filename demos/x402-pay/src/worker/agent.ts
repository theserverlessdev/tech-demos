import { toClientEvmSigner } from "@x402/evm";
import { Agent } from "agents";
import { withX402Client } from "agents/x402";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MAX_PAYMENT_ATOMIC, NETWORK, isPrivateKey, priceOf, type CanonicalArgs, type ToolName } from "../shared/protocol";
import type { Env } from "./env";
import { viewToolResult, type ToolView } from "./interpret";
import { acceptsBound, boundFor, payeeForMode, resolveMode, signableCharge, type CatalogCharge } from "./policy";

export class PayAgent extends Agent<Env> {
  initialState = { phase: "ready" };
  private serverId: string | null = null;
  private mockKey: `0x${string}` | null = null;
  private rawCall: ((params: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>) | null = null;
  private payer: ReturnType<typeof withX402Client> | null = null;

  private mode() {
    return resolveMode({
      local: this.env.LOCAL_DEV === "1",
      modeFlag: this.env.X402_MODE,
      facilitatorOrigin: this.env.MOCK_FACILITATOR_ORIGIN,
      payee: this.env.X402_PAYEE_ADDRESS,
      privateKey: this.env.X402_CLIENT_PRIVATE_KEY,
    });
  }

  override async onStart() {
    const servers = this.getMcpServers().servers;
    const ids = Object.keys(servers);
    if (ids.length > 0) {
      this.serverId = ids.find((id) => servers[id]?.state === "ready") ?? ids[0] ?? null;
      return;
    }
    try {
      const added = await this.addMcpServer("pay-mcp", this.env.PAY_MCP);
      this.serverId = added.id;
    } catch (err) {
      console.log(JSON.stringify({ event: "mcp_connect_failed", name: err instanceof Error ? err.name : "error" }));
    }
  }

  override async onRequest(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method !== "POST") return Response.json({ paid: false, error: { code: "method", message: "POST only." } }, { status: 405 });
      const body = (await request.json()) as { tool?: unknown; args?: unknown; amount?: unknown; payTo?: unknown };
      const tool = body.tool;
      const args = body.args;
      if (tool !== "echo" && tool !== "square" && tool !== "summarize") {
        return Response.json({ paid: false, error: { code: "bad_tool", message: "Unknown tool." } }, { status: 400 });
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return Response.json({ paid: false, error: { code: "bad_args", message: "Arguments must be an object." } }, { status: 400 });
      }
      const view = url.pathname.endsWith("/pay")
        ? await this.pay(tool, args as CanonicalArgs, {
            amount: typeof body.amount === "string" ? body.amount : "",
            payTo: typeof body.payTo === "string" ? body.payTo : "",
          })
        : await this.probe(tool, args as CanonicalArgs);
      return Response.json(view, { headers: { "cache-control": "no-store" } });
    } catch (err) {
      console.log(JSON.stringify({ event: "agent_error", name: err instanceof Error ? err.name : "error" }));
      return Response.json(
        { paid: false, isError: true, setup: false, challenge: null, success: false, transaction: "", network: "", code: "agent_error", reason: "", text: "The agent could not complete that call." },
        { status: 500 },
      );
    }
  }

  private connection() {
    if (!this.serverId) return null;
    return this.mcp.mcpConnections[this.serverId] ?? null;
  }

  private captureRaw(): boolean {
    if (this.rawCall) return true;
    const connection = this.connection();
    if (!connection) return false;
    const call = connection.client.callTool.bind(connection.client);
    this.rawCall = (params) => call(params);
    return true;
  }

  private async probe(tool: ToolName, args: CanonicalArgs): Promise<ToolView> {
    if (!this.captureRaw() || !this.rawCall) {
      return { text: "The MCP server is not connected.", isError: true, setup: false, challenge: null, success: false, transaction: "", network: "", code: "mcp_unavailable", reason: "" };
    }
    const result = await this.rawCall({ name: tool, arguments: args });
    return viewToolResult(result);
  }

  private signingKey(): `0x${string}` | null {
    const mode = this.mode();
    if (mode === "mock") {
      if (!this.mockKey) this.mockKey = generatePrivateKey();
      return this.mockKey;
    }
    if (mode === "testnet" && isPrivateKey(this.env.X402_CLIENT_PRIVATE_KEY)) return this.env.X402_CLIENT_PRIVATE_KEY;
    return null;
  }

  private client() {
    if (this.payer) return this.payer;
    const connection = this.connection();
    const key = this.signingKey();
    if (!connection || !key) return null;
    this.captureRaw();
    const account = privateKeyToAccount(key);
    this.payer = withX402Client(connection.client, {
      network: NETWORK,
      account: toClientEvmSigner(account),
      maxPaymentValue: MAX_PAYMENT_ATOMIC,
    });
    return this.payer;
  }

  private async pay(tool: ToolName, args: CanonicalArgs, charge: CatalogCharge): Promise<ToolView> {
    const catalogAmount = priceOf(tool);
    const mode = this.mode();
    if (!catalogAmount || mode === "pending") {
      return { text: "Paid tools are off until the testnet payee and signing key are set.", isError: true, setup: true, challenge: null, success: false, transaction: "", network: "", code: "setup_pending", reason: "" };
    }
    const catalogPayee = payeeForMode(mode, this.env.X402_PAYEE_ADDRESS);
    const decision = signableCharge(charge, { amount: catalogAmount, payTo: catalogPayee });
    if (!decision.ok) {
      return { text: "The confirmed amount or payee does not match this worker.", isError: true, setup: false, challenge: null, success: false, transaction: "", network: "", code: "altered", reason: "" };
    }
    const bound = boundFor(tool, decision.payTo, decision.amount);
    const client = this.client();
    if (!client) {
      return { text: "The payer is not ready.", isError: true, setup: false, challenge: null, success: false, transaction: "", network: "", code: "mcp_unavailable", reason: "" };
    }
    const result = await client.callTool(async (requirements) => acceptsBound(requirements, bound), { name: tool, arguments: args });
    return viewToolResult(result);
  }
}
