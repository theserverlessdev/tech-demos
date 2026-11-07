/**
 * Local stand-in for the x402 facilitator. It is not Base Sepolia and it does not move test USDC.
 *
 *   bun run scripts/mock-facilitator.ts
 *
 * Then start the Worker with LOCAL_DEV=1, X402_MODE=mock, and
 * MOCK_FACILITATOR_ORIGIN=http://127.0.0.1:<port printed here>.
 */
import { createServer } from "node:http";
import { mockFacilitatorResponse, memoryStore } from "../src/worker/mock-facilitator";

const port = Number(process.env.PORT ?? "8796");
const store = memoryStore();
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  const request = new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, {
    method: req.method,
    headers: { "content-type": "application/json" },
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
  const response = await mockFacilitatorResponse(request, store);
  const text = response ? await response.text() : "";
  res.writeHead(response?.status ?? 404, { "content-type": "application/json" });
  res.end(text);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Mock facilitator on http://127.0.0.1:${port}/internal/mock-facilitator`);
  console.log("Not a Base Sepolia payment. No test USDC moves.");
});
