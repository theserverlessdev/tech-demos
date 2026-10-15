/** Local OpenAI-compatible mock for BYOK playground validation. */
import { leftColourFromPngBase64 } from "../src/shared/png";

const PORT = Number(process.env.MOCK_PORT ?? 8799);
const HOST = process.env.MOCK_HOST ?? "127.0.0.1";

const MODELS = ["mock-gpt", "mock-gpt-vision", "fail-model"];

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "access-control-allow-origin": "*" } });
}

function sseChunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }], usage: { completion_tokens: 8 } })}\n\n`;
}

async function chat(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    model?: string;
    stream?: boolean;
    tools?: unknown;
    response_format?: { type?: string; json_schema?: { schema?: { properties?: { nonce?: { const?: string } } } } };
    messages?: { content?: unknown }[];
  };
  if (body.model === "fail-model") {
    return json({ error: { message: "Incorrect API key provided: sk-should-never-leak" } }, 401);
  }
  if (body.model === "missing-model") {
    return json({ error: { message: "model_not_found", code: "model_not_found" } }, 404);
  }
  const image = Array.isArray(body.messages)
    ? body.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])).find((part) => typeof part === "object" && part && "image_url" in part)
    : undefined;
  const imageUrl = image && typeof image === "object" && image && "image_url" in image
    ? (image as { image_url?: { url?: string } }).image_url?.url ?? ""
    : "";
  const pngB64 = imageUrl.startsWith("data:image/png;base64,") ? imageUrl.slice("data:image/png;base64,".length) : "";
  const leftColour = pngB64 ? leftColourFromPngBase64(pngB64) : null;
  const content = leftColour ?? "Hello from the mock OpenAI-compatible server.";

  if (body.tools) {
    return json({
      choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "ping", arguments: "{}" } }] } }],
    });
  }
  if (body.response_format?.type === "json_schema") {
    const nonce = body.response_format.json_schema?.schema?.properties?.nonce?.const ?? "nonce";
    return json({ choices: [{ message: { role: "assistant", content: JSON.stringify({ ok: true, nonce }) } }] });
  }
  if (body.stream) {
    const words = content.split(" ");
    const stream = new ReadableStream({
      async start(controller) {
        for (let i = 0; i < words.length; i++) {
          const token = (i === 0 ? "" : " ") + words[i];
          controller.enqueue(new TextEncoder().encode(sseChunk(token)));
          await Bun.sleep(40);
        }
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } });
  }
  return json({
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 },
  });
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      return json({ data: MODELS.map((id) => ({ id, object: "model" })) });
    }
    if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) return chat(req);
    return json({ error: { message: "Not found" } }, 404);
  },
});

console.log(`mock openai listening on http://${server.hostname}:${server.port}/v1`);
