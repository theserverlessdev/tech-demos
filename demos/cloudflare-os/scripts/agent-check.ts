// bun run scripts/agent-check.ts [baseUrl] "prompt" ["prompt2" ...]
import { RpcTarget, newWebSocketRpcSession } from "capnweb";
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const [base = "http://127.0.0.1:8795", ...prompts] = process.argv.slice(2);
const root: Any = newWebSocketRpcSession(base.replace(/^http/, "ws") + "/api");
const id = `agent${Date.now().toString(36)}`;
const ws: Any = root.openWorkspace(id, { id: "agentcheck", name: "Agent Check", color: "#c2410c" });
let snap: Any = null;
class L extends RpcTarget { event(e: Any) { if (e.type === "snapshot") snap = e.snapshot; } }
await ws.subscribe(new L());
setInterval(() => ws.ping().catch(() => {}), 15_000);
for (const p of prompts) {
  const t0 = Date.now();
  await ws.chat(p);
  await new Promise((r) => setTimeout(r, 300));
  console.log(`\n>>> ${p}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  const since = snap.chat.filter((m: Any) => m.at >= t0 - 1000);
  for (const m of since) {
    if (m.role === "tool") console.log(`  [tool ${m.tool.name}] ${m.tool.ok ? "ok" : "FAIL"} args=${m.tool.args} → ${m.tool.result.slice(0, 160)}`);
    else console.log(`  [${m.role}] ${m.content.slice(0, 300)}`);
  }
  console.log(`  cost so far: $${snap.cost.usd.toFixed(5)} in=${snap.cost.tokensIn} out=${snap.cost.tokensOut}`);
}
console.log(`\ngadgets: ${snap.gadgets.map((g: Any) => `${g.id}:${g.blueprint}`).join(", ")}`);
console.log(`${base}/?w=${id}`);
process.exit(0);
