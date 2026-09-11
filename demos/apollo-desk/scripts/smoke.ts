// Smoke test: bun run scripts/smoke.ts [baseUrl] [--voice path/to/16k-mono.wav]
// Acts as a desk over the Agents SDK WebSocket. It sends turns, answers MCP calls, reconnects, and checks memory.
import { AgentClient } from "agents/client";
import type { BrainMessage, Inspection, JsonRpcRequest, TraceEntry } from "../src/shared/protocol";

const args = process.argv.slice(2);
const base = new URL((args.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8795").replace(/\/$/, "") + "/");
const voiceIdx = args.indexOf("--voice");
const voicePath = voiceIdx >= 0 ? args[voiceIdx + 1] : undefined;
const desk = `smoke${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`.slice(0, 24);
const prefix = base.pathname.replace(/^\/|\/$/g, "");

function check(label: string, ok: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) process.exitCode = 1;
}

type Desk = { client: AgentClient; frames: BrainMessage[]; traces: TraceEntry[]; waitFor: (pred: (m: BrainMessage) => boolean, ms?: number) => Promise<BrainMessage> };

function connect(): Promise<Desk> {
  const frames: BrainMessage[] = [];
  const traces: TraceEntry[] = [];
  const waiters: { pred: (m: BrainMessage) => boolean; resolve: (m: BrainMessage) => void }[] = [];
  const client = new AgentClient({
    agent: "Apollo",
    name: desk,
    host: base.host,
    protocol: base.protocol === "https:" ? "wss" : "ws",
    basePath: [prefix, "agents/apollo", desk].filter(Boolean).join("/"),
  });
  const volume = { level: 70 };
  client.addEventListener("message", (ev: MessageEvent) => {
    if (typeof ev.data !== "string") return;
    const msg = JSON.parse(ev.data) as BrainMessage & { type: string };
    if (!msg.type || msg.type.startsWith("cf_agent") || msg.type === "rpc") return;
    frames.push(msg);
    if (msg.type === "trace") traces.push(msg.entry);
    if (msg.type === "mcp") answerMcp(client, msg.payload, volume);
    for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
  });
  const waitFor = (pred: (m: BrainMessage) => boolean, ms = 60_000) =>
    new Promise<BrainMessage>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out waiting for frame")), ms);
      waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  return new Promise((resolve) => client.addEventListener("open", () => resolve({ client, frames, traces, waitFor }), { once: true }));
}

function answerMcp(client: AgentClient, req: JsonRpcRequest, volume: { level: number }) {
  const params = req.params as { name: string; arguments: Record<string, number> };
  if (params.name === "self.audio_speaker.set_volume") volume.level = params.arguments.volume ?? volume.level;
  const text = JSON.stringify({ volume: volume.level, brightness: 80, firmwareVersion: "smoke" });
  client.send(JSON.stringify({ type: "mcp", payload: { jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text }] } }, ts: Date.now() }));
}

const turn = async (d: Desk, text: string) => {
  const start = d.frames.length;
  d.client.send(JSON.stringify({ type: "text_input", text, ts: Date.now() }));
  await d.waitFor((m) => m.type === "turn_end", 90_000);
  const frames = d.frames.slice(start);
  const speaking = frames.filter((f) => f.type === "ui_state" && f.state === "speaking").pop() as Extract<BrainMessage, { type: "ui_state" }> | undefined;
  const errors = frames.filter((f) => f.type === "error");
  console.log(`      you: ${text}\n      apollo: ${speaking?.caption ?? "(no reply)"}${errors.length ? `\n      errors: ${JSON.stringify(errors)}` : ""}`);
  return frames;
};
const toolsIn = (frames: BrainMessage[]) =>
  frames.flatMap((f) => (f.type === "trace" && f.entry.kind === "tool" ? [f.entry] : []));

console.log(`desk ${desk} at ${base}`);
let d = await connect();
d.client.send(JSON.stringify({ type: "hello", deviceId: "smoke", firmwareVersion: "smoke", ts: Date.now() }));
await d.waitFor((m) => m.type === "ui_state");

let frames = await turn(d, "Remember that my favourite tea is jasmine. Also set a 2 minute tea timer.");
const tools1 = toolsIn(frames);
check(`remember_fact ran (${tools1.map((t) => t.name).join(", ")})`, tools1.some((t) => t.name === "remember_fact" && t.ok));
check("set_timer ran and sent a timer frame", frames.some((f) => f.type === "timer"));
check("tts audio frames came down", frames.some((f) => f.type === "tts_start"));

frames = await turn(d, "Turn the volume down to 30.");
check("set_volume went over the MCP bridge", frames.some((f) => f.type === "mcp") && toolsIn(frames).some((t) => t.name === "set_volume" && t.ok));

d.client.close();
console.log("      (reconnect)");
d = await connect();
d.client.send(JSON.stringify({ type: "hello", deviceId: "smoke", ts: Date.now() }));
const timer = await d.waitFor((m) => m.type === "timer", 10_000).catch(() => null);
check("timer arc came back after reconnect", timer);
const inspection = (await d.client.call("inspect", [])) as Inspection;
check(`memory kept after reconnect (${inspection.facts.map((f) => `${f.fact} [${f.dims}d]`).join("; ")})`, inspection.facts.some((f) => /jasmine/i.test(f.fact)));
check(`tables: ${inspection.tables.map((t) => `${t.name}=${t.rows}`).join(", ")}`, inspection.tables.length >= 4);

frames = await turn(d, "What tea do I like?");
const recall = frames.find((f) => f.type === "trace" && f.entry.kind === "recall") as Extract<BrainMessage, { type: "trace" }> | undefined;
check(`recall found the fact ${JSON.stringify(recall?.entry)}`, recall && JSON.stringify(recall.entry).includes("jasmine"));
const reply = frames.filter((f) => f.type === "ui_state" && f.state === "speaking").pop() as { caption?: string } | undefined;
check("reply mentions jasmine", /jasmine/i.test(reply?.caption ?? ""));

frames = await turn(d, "Please forget everything you know about me.");
const confirm = frames.find((f) => f.type === "confirm_request");
check("forget_everything asked for confirmation", confirm);
if (confirm) {
  d.client.send(JSON.stringify({ type: "confirm", ok: false, ts: Date.now() }));
  const close = await d.waitFor((m) => m.type === "confirm_close");
  check("No closed the confirmation", close.type === "confirm_close" && close.reason === "declined");
  await d.waitFor((m) => m.type === "turn_end");
}

if (voicePath) {
  const wav = new Uint8Array(await Bun.file(voicePath).arrayBuffer());
  d.client.send(JSON.stringify({ type: "hold_start", ts: Date.now() }));
  for (let i = 44; i < wav.length; i += 3200) d.client.send(wav.slice(i, i + 3200));
  d.client.send(JSON.stringify({ type: "hold_end", ts: Date.now() }));
  const heard = (await d.waitFor((m) => m.type === "trace" && m.entry.kind === "heard")) as Extract<BrainMessage, { type: "trace" }>;
  check(`voice turn transcribed: ${JSON.stringify(heard.entry)}`, heard.entry.kind === "heard" && heard.entry.text.length > 3);
  await d.waitFor((m) => m.type === "turn_end", 90_000);
}

const cost = d.traces;
void cost;
d.client.close();
process.exit(process.exitCode ?? 0);
