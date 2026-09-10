// Smoke test: bun run scripts/smoke.ts [baseUrl]
// Connects over Cap'n Web like the shell, creates each blueprint, and calls one method on each facet.
import { RpcTarget, newWebSocketRpcSession } from "capnweb";

const base = (process.argv[2] ?? "http://127.0.0.1:8795").replace(/\/$/, "");
const wsUrl = base.replace(/^http/, "ws") + "/api";
const workspace = `smoke${Date.now().toString(36)}`;

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const events: string[] = [];
class Listener extends RpcTarget {
  event(e: Any) {
    events.push(e.type);
  }
}

function check(label: string, ok: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) process.exitCode = 1;
}

const root: Any = newWebSocketRpcSession(wsUrl);
const ws: Any = root.openWorkspace(workspace, { id: "smoke", name: "Smoke Test", color: "#c2410c" });
await ws.subscribe(new Listener());
const blueprints = await ws.listBlueprints();
check(`listBlueprints returns 4 (${blueprints.map((b: Any) => b.id).join(", ")})`, blueprints.length === 4);

const tic = await ws.createGadget("tictactoe");
check(`createGadget tictactoe → ${tic.id} loader ${tic.loaderId}`, tic.id === "gadget1");

const facet: Any = await ws.connectToGadget(tic.id);
let pushed = 0;
class TicListener extends RpcTarget {
  stateChanged() {
    pushed++;
  }
}
await facet.subscribe(new TicListener());
const s1 = await facet.move(4, "Smoke");
check(`tictactoe.move(4) via Cap'n Web → facet: board[4]=${s1.board[4]}`, s1.board[4] === "X");
const s2 = await facet.getState();
check("facet state persists between calls", s2.board[4] === "X");
await new Promise((r) => setTimeout(r, 300));
check(`subscribe callback crossed browser → Worker → DO → facet and back (${pushed} pushes)`, pushed >= 1);

const report = await ws.inspectStorage(tic.id);
check(`inspectStorage sees facet SQLite tables: ${report.tables.map((t: Any) => `${t.name}(${t.rows})`).join(", ")}`, report.tables.length > 0);

const slides = await ws.createGadget("slides");
const sf: Any = await ws.connectToGadget(slides.id);
const deck = await sf.getDeck();
check(`slides.getDeck → ${deck.slides.length} slides`, deck.slides.length > 0);

const pixels = await ws.createGadget("pixels");
const pf: Any = await ws.connectToGadget(pixels.id);
const painted = await pf.paintMany([{ x: 1, y: 1, color: 0 }, { x: 2, y: 2, color: 1 }, { x: 99, y: 1, color: 0 }], "Smoke");
check(`pixels.paintMany applied ${painted.applied} of 3 (one invalid)`, painted.applied === 2);
check(`pixels loader id is shared by content hash: ${pixels.loaderId}`, pixels.loaderId.startsWith("code."));

const head = await ws.createGadget("headlines");
check(`headlines has bindings ${head.bindings} and a workspace-scoped loader id ${head.loaderId}`, head.loaderId.startsWith("ws."));
const hf: Any = await ws.connectToGadget(head.id);
const refresh = hf.refresh();
await new Promise((r) => setTimeout(r, 800));
let snapshot: Any = null;
class SnapListener extends RpcTarget {
  event(e: Any) {
    if (e.type === "snapshot") snapshot = e.snapshot;
  }
}
await ws.subscribe(new SnapListener());
await new Promise((r) => setTimeout(r, 400));
const pending = snapshot?.actions?.find((a: Any) => a.status === "pending");
check(`WEB gatekeeper queued an approval: ${pending?.title}`, !!pending);
if (pending) await ws.decideAction(pending.id, true, false);
const result = await refresh.catch((e: Any) => ({ error: String(e) }));
check(`headlines.refresh after approval → ${result.items?.length ?? 0} items ${result.error ?? ""}`, (result.items?.length ?? 0) > 0);

// Hot reload keeps facet storage.
const files = await ws.getFiles(tic.id);
const info = await ws.writeFile(tic.id, "server.js", files["server.js"] + "\n// hot reload\n");
check(`writeFile bumps version to ${info.version} and a new loader id ${info.loaderId}`, info.version === 2 && info.loaderId !== tic.loaderId);
const facet2: Any = await ws.connectToGadget(tic.id);
const s3 = await facet2.getState();
check("facet SQLite survives the code change", s3.board[4] === "X");

// Isolation: a custom gadget cannot fetch.
const custom = await ws.writeFile(tic.id, "server.js", `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject { async tryFetch() { try { await fetch("https://example.com"); return "fetched"; } catch (e) { return "blocked: " + e.message; } } }`);
const cf: Any = await ws.connectToGadget(tic.id);
const tried = await cf.tryFetch();
check(`globalOutbound null blocks fetch from the gadget: ${tried} (v${custom.version})`, String(tried).startsWith("blocked"));

check(`workspace events received: ${[...new Set(events)].join(", ")}`, events.includes("snapshot") && events.includes("rpc"));
root[Symbol.dispose]();
console.log(`\nworkspace: ${base}/?w=${workspace}`);
process.exit(process.exitCode ?? 0);
