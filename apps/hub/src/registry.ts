import type { DemoMeta } from "@tech-demos/shared";

export type DemoEntry = DemoMeta & {
  /** Raw Worker module source loaded into a Dynamic Worker (plain JS) */
  source: string;
};

const helloDynamicSource = `export default {
  async fetch(request) {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "world";
    const html = \`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>hello-dynamic</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0e0e11; color: #c9c9c4; font-family: ui-sans-serif, system-ui, sans-serif; }
      main { margin: 1rem; padding: 1.5rem; border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; background: #17171b; max-width: 34rem; }
      h1 { margin: 0.35rem 0 0.75rem; color: #e8e8e4; font-size: 1.75rem; letter-spacing: -0.03em; }
      .k { margin: 0; font-family: ui-monospace, monospace; font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase; color: #c2410c; }
      p { line-height: 1.5; overflow-wrap: anywhere; }
      code { color: #e2622e; }
      a { color: #e8e8e4; }
    </style>
  </head>
  <body>
    <main>
      <p class="k">What this shows</p>
      <h1>Hello, \${name}</h1>
      <p>The hub Worker Loader compiles this module at request time and serves it as an isolated Dynamic Worker. Nothing is stored.</p>
      <p>Try <code>?name=Ankur</code>.</p>
      <p><a href="https://theserverless.dev/contact">Contact</a></p>
    </main>
  </body>
</html>\`;
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
`;

// cloudflare-os is a standalone Worker (Durable Objects, Workers AI, its own Worker Loader). A zone route
// sends /demos/cloudflare-os* to it before the hub sees the request. This source only runs if that route
// is missing, and it sends the visitor to the demo subdomain.
const cloudflareOsFallbackSource = `export default {
  fetch(request) {
    const url = new URL(request.url);
    const rest = url.pathname.replace(/^\\/demos\\/cloudflare-os/, "") || "/";
    return Response.redirect("https://cloudflare-os.tech-demos.theserverless.dev" + rest + url.search, 302);
  },
};
`;

// apollo-desk is a standalone Worker (Agents SDK Durable Object, Workers AI). Same pattern as cloudflare-os:
// the zone route wins, and this source only redirects if that route is missing.
const apolloDeskFallbackSource = `export default {
  fetch(request) {
    const url = new URL(request.url);
    const rest = url.pathname.replace(/^\\/demos\\/apollo-desk/, "") || "/";
    return Response.redirect("https://apollo-desk.tech-demos.theserverless.dev" + rest + url.search, 302);
  },
};
`;

// temp-email is a standalone Worker (Email Worker, D1, cron). Its home is email.lomvic.com, because
// the addresses live on that throwaway mail zone. The TSD hub route sends /demos/temp-email* to the Worker, which redirects there.
// This source only runs if that route is missing.
const tempEmailFallbackSource = `export default {
  fetch(request) {
    const url = new URL(request.url);
    const rest = url.pathname.replace(/^\\/demos\\/temp-email/, "") || "/";
    return Response.redirect("https://email.lomvic.com" + rest + url.search, 302);
  },
};
`;

// resolve-hq is a standalone Worker (D1, R2, Queues, Workers AI). Same pattern as apollo-desk:
// the zone route wins, and this source only redirects if that route is missing.
const resolveHqFallbackSource = `export default {
  fetch(request) {
    const url = new URL(request.url);
    const rest = url.pathname.replace(/^\\/demos\\/resolve-hq/, "") || "/";
    return Response.redirect("https://resolve-hq.tech-demos.theserverless.dev" + rest + url.search, 302);
  },
};
`;

// personal-agent is a standalone Worker (Agents SDK Durable Object, R2, Workers AI).
// The zone route wins, and this source only redirects if that route is missing.
const personalAgentFallbackSource = `export default {
  fetch(request) {
    const url = new URL(request.url);
    const rest = url.pathname.replace(/^\\/demos\\/personal-agent/, "") || "/";
    return Response.redirect("https://personal-agent.tech-demos.theserverless.dev" + rest + url.search, 302);
  },
};
`;

// partyserver is a standalone Worker (hibernating PartyServer Durable Object + Yjs). Same pattern as resolve-hq:
// the zone route wins, and this source only redirects if that route is missing.
const partyserverFallbackSource = `export default {
  fetch(request) {
    const url = new URL(request.url);
    const rest = url.pathname.replace(/^\\/demos\\/partyserver/, "") || "/";
    return Response.redirect("https://partyserver.tech-demos.theserverless.dev" + rest + url.search, 302);
  },
};
`;

// feedlog is a standalone Worker (D1, R2, Vectorize, Workers AI). Same pattern as resolve-hq:
// the zone route wins, and this source only redirects if that route is missing.
const feedlogFallbackSource = `export default {
  fetch(request) {
    const url = new URL(request.url);
    const rest = url.pathname.replace(/^\\/demos\\/feedlog/, "") || "/";
    return Response.redirect("https://feedlog.tech-demos.theserverless.dev" + rest + url.search, 302);
  },
};
`;

// company-brain is a standalone Worker (Agents SDK Durable Object, Workers AI). Same pattern as resolve-hq:
// the zone route wins, and this source only redirects if that route is missing.
const companyBrainFallbackSource = `export default {
  fetch(request) {
    const url = new URL(request.url);
    const rest = url.pathname.replace(/^\\/demos\\/company-brain/, "") || "/";
    return Response.redirect("https://company-brain.tech-demos.theserverless.dev" + rest + url.search, 302);
  },
};
`;

// clef-gate is a standalone Worker (Agents SDK Durable Object, Workers AI, D1). Same pattern as resolve-hq:
// the zone route wins, and this source only redirects if that route is missing.
const clefGateFallbackSource = `export default {
  fetch(request) {
    const url = new URL(request.url);
    const rest = url.pathname.replace(/^\\/demos\\/clef-gate/, "") || "/";
    return Response.redirect("https://clef-gate.tech-demos.theserverless.dev" + rest + url.search, 302);
  },
};
`;

// tanbase is a standalone Worker (D1, Board Durable Object, R2, Workflows, Workers AI).
// The zone route wins; this source only redirects if that route is missing.
const tanbaseFallbackSource = `export default {
  fetch(request) {
    const url = new URL(request.url);
    const rest = url.pathname.replace(/^\\/demos\\/tanbase/, "") || "/";
    return Response.redirect("https://tanbase.tech-demos.theserverless.dev" + rest + url.search, 302);
  },
};
`;

// actor-lab is a standalone Worker (SQLite Durable Objects, Workers AI, hibernatable WebSockets).
// Same pattern as resolve-hq: the zone route wins, and this source only redirects if that route is missing.
const actorLabFallbackSource = `export default {
  fetch(request) {
    const url = new URL(request.url);
    const rest = url.pathname.replace(/^\\/demos\\/actor-lab/, "") || "/";
    return Response.redirect("https://actor-lab.tech-demos.theserverless.dev" + rest + url.search, 302);
  },
};
`;

// repo-per-agent is a standalone Worker (Artifacts, Agents SDK, D1). Same pattern as resolve-hq:
// the zone route wins, and this source only redirects if that route is missing.
const repoPerAgentFallbackSource = `export default {
  fetch(request) {
    const url = new URL(request.url);
    const rest = url.pathname.replace(/^\\/demos\\/repo-per-agent/, "") || "/";
    return Response.redirect("https://repo-per-agent.tech-demos.theserverless.dev" + rest + url.search, 302);
  },
};
`;

// edgechat is a standalone Worker (Durable Objects, D1, KV, R2). Same pattern as resolve-hq:
// the zone route wins, and this source only redirects if that route is missing.
const edgechatFallbackSource = `export default {
  fetch(request) {
    const url = new URL(request.url);
    const rest = url.pathname.replace(/^\\/demos\\/edgechat/, "") || "/";
    return Response.redirect("https://edgechat.tech-demos.theserverless.dev" + rest + url.search, 302);
  },
};
`;

// goodvibes is a standalone Worker (Durable Objects + Static Assets). Same pattern as resolve-hq:
// the zone route wins, and this source only redirects if that route is missing.
const goodvibesFallbackSource = `export default {
  fetch(request) {
    const url = new URL(request.url);
    const rest = url.pathname.replace(/^\\/demos\\/goodvibes/, "") || "/";
    return Response.redirect("https://goodvibes.tech-demos.theserverless.dev" + rest + url.search, 302);
  },
};
`;

export const demos: DemoEntry[] = [
  {
    slug: "goodvibes",
    title: "GoodVibes",
    description: "A 75-second multiplayer orb hunt. Highest score in the room wins.",
    demonstrates:
      "One Durable Object per room is the coordinator: hibernating WebSockets carry poses and scores, and an alarm runs the 75-second round. The room owns the orbs and the clock, so a second tab is another player, not another copy of the game.",
    capabilities: [
      "Join or create a named room and open it in a second tab",
      "Start a 75-second round and move with the keyboard, a click, or the pad",
      "Collect ember orbs (+1) and gold orbs (+3); the highest score wins",
      "Play again without leaving the room",
      "Play the same round on a 2D floor when WebGL cannot start",
    ],
    useCases: [
      "A realtime game where the server owns positions, pickups, and the round clock",
      "A classroom activity with a shared timer and a scoreboard",
      "Any room that should hibernate when the last player leaves",
    ],
    tags: ["durable-objects", "websockets", "threejs", "game"],
    source: goodvibesFallbackSource,
  },
  {
    slug: "edgechat",
    title: "EdgeChat",
    description: "A mini team chat. A message in one tab shows up in the other tabs in that room.",
    demonstrates:
      "One ChatRoom Durable Object per room name fans out hibernating WebSockets. D1 keeps the transcript across refresh, KV stores the display name, and R2 holds an attachment the message can link to.",
    capabilities: [
      "Join the same room in two tabs and watch a message arrive in both",
      "Refresh and still see the transcript stored in D1",
      "Set a display name that is kept in KV",
      "Attach a file; the message links to the R2 object, and images preview",
    ],
    useCases: [
      "An incident channel where the transcript survives a refresh",
      "In-product comments with file drops",
      "A support room that hibernates when nobody is connected",
    ],
    tags: ["durable-objects", "d1", "kv", "r2", "websockets"],
    source: edgechatFallbackSource,
  },
  {
    slug: "resolve-hq",
    title: "ResolveHQ",
    description: "A shared support inbox: tickets, files, simulated mail, and a draft reply.",
    demonstrates:
      "A Worker coordinates D1 tickets, R2 attachments, and a Queue consumer that turns a simulated inbound email into a ticket or a thread reply. Workers AI fills a draft and falls back to a stub if the model fails. There is no live mail exchanger.",
    capabilities: [
      "Open a seeded ticket and read the thread",
      "Attach a file and download it",
      "Simulate inbound mail and watch the consumer create or append a ticket",
      "Ask for a draft reply, including the stub used when Workers AI fails",
    ],
    useCases: [
      "A small shared inbox without a live mail route yet",
      "Queue-backed intake that becomes tickets",
      "A reply desk that still fills a draft when the model is down",
    ],
    tags: ["d1", "r2", "queues", "workers-ai"],
    source: resolveHqFallbackSource,
  },
  {
    slug: "temp-email",
    title: "Temp email",
    description: "Disposable inboxes on email.lomvic.com, plus a key you mint for an agent.",
    demonstrates:
      "An Email Worker receives catch-all mail, parses the MIME message, and stores metadata in D1 and attachment bytes in R2. A cron deletes expired inboxes. An agent mints its own Turnstile-gated key and can long-poll for the next message.",
    capabilities: [
      "Mint a short-lived address and copy it",
      "Send the sample message and read the extracted code or link",
      "Open HTML mail in a sandboxed frame; remote images stay blocked until you allow them",
      "Mint a Turnstile-gated agent key, shown once, for the long-poll API",
      "Deploy the same Worker onto your own zone",
    ],
    useCases: [
      "Throwaway inboxes for signup and one-time-code tests",
      "An agent that waits on the next message instead of sharing one API secret",
      "A self-hosted mail zone with the same Email Worker, D1, and R2 layout",
    ],
    tags: ["email-workers", "email-routing", "d1", "cron", "agents"],
    source: tempEmailFallbackSource,
  },
  {
    slug: "apollo-desk",
    title: "Apollo desk",
    description: "A browser desk that talks to one Agents SDK brain and keeps the conversation.",
    demonstrates:
      "One Agents SDK Durable Object per desk runs the voice turn — speech to text, a tool loop, then speech — and stores SQLite memory with vector recall, schedules, and a confirmation gate. The desk is an MCP server the brain calls on the same WebSocket.",
    capabilities: [
      "Hold to talk, type, or tap a suggested turn",
      "Save a fact, a list item, or a timer, then refresh and see them return",
      "Ask it to change the volume; the brain calls the MCP server in the desk",
      "Ask it to forget everything and confirm or cancel within 30 seconds",
      "Open the console for the SQLite transcript, vector scores, and the turn trace",
    ],
    useCases: [
      "A voice appliance whose tools live on the device and whose memory lives in one Durable Object",
      "A personal list and timer that survive a refresh",
      "An agent that asks before it runs an unsafe tool",
    ],
    tags: ["agents-sdk", "durable-objects", "workers-ai", "voice", "mcp"],
    source: apolloDeskFallbackSource,
  },
  {
    slug: "cloudflare-os",
    title: "Cloudflare OS, sliced",
    description: "An agent workspace where each gadget runs in its own Dynamic Worker.",
    demonstrates:
      "Gadgets run as Durable Object facets inside Dynamic Workers, each with private SQLite. The sandboxed UI calls the facet over Cap'n Web, and a gatekeeper holds an outside read until a person approves it.",
    capabilities: [
      "Open one workspace link in two tabs",
      "Spawn Slides, Tic-tac-toe, Pixel Board, or Headlines, or ask the agent to draw",
      "Use the gadget inside a sandboxed frame",
      "Approve or deny the Headlines gadget's fetch of hn.algolia.com",
      "Inspect RPC timings and that facet's SQLite tables",
    ],
    useCases: [
      "An internal workspace where each tool is a sandboxed worker with its own database",
      "An agent that can edit a gadget but cannot fetch until someone approves",
      "A host for small multiplayer apps that share one workspace link",
    ],
    tags: ["dynamic-workers", "do-facets", "capnweb", "workers-ai", "agents"],
    source: cloudflareOsFallbackSource,
  },
  {
    slug: "hello-dynamic",
    title: "Hello Dynamic Worker",
    description: "A one-file HTML page the hub loads as a Dynamic Worker.",
    demonstrates:
      "The hub Worker Loader compiles this module at request time and serves it as an isolated Dynamic Worker. The page has no Durable Object, no bindings, and no stored state.",
    capabilities: [
      "Open the page served by the loaded worker",
      "Change ?name= and see the greeting update",
      "Confirm the HTML comes from the Dynamic Worker, not a static file on the hub",
    ],
    useCases: [
      "A gallery that loads a snippet without a separate Worker deploy",
      "A preview of generated worker code",
      "A check that the loader path works before you add bindings",
    ],
    tags: ["dynamic-workers", "starter"],
    source: helloDynamicSource,
  },
  {
    slug: "personal-agent",
    title: "Personal agent",
    description: "An anonymous assistant with notes, recall, and a short research pass.",
    demonstrates:
      "One Agents SDK Durable Object per anonymous visitor holds the thread and embedding vectors. Markdown notes live in R2 under that visitor's prefix, and research fetches 2–4 allowlisted pages. An alarm deletes that visitor's rows and objects 24 hours after the last write.",
    capabilities: [
      "Chat with the assistant bound to this browser's visitor id",
      "Create, open, and delete markdown notes in R2",
      "See the note title and score under a reply that used memory",
      "Run research over 2–4 allowlisted pages and read the citations",
      "Start a new visitor, which is a different Durable Object",
    ],
    useCases: [
      "A notes-backed assistant for one person, with no account",
      "A research sidebar that only fetches an allowlist",
      "A demo tenant that deletes its own storage on a timer",
    ],
    tags: ["agents-sdk", "durable-objects", "r2", "workers-ai"],
    source: personalAgentFallbackSource,
  },
  {
    slug: "partyserver",
    title: "Partyboard",
    description: "A shared ink board. A stroke in one tab shows up in the others.",
    demonstrates:
      "PartyServer routes each ink room to one hibernating Durable Object. Yjs strokes persist in Durable Object storage; cursors stay on the awareness channel and are not stored. An alarm wipes the room two hours after it is created.",
    capabilities: [
      "Open a room after the Turnstile check and send the link",
      "Draw and watch the stroke sync to another tab",
      "See live cursors that disappear when the socket closes",
      "Hit the caps: 8 people, 240 strokes, and a 256 KB snapshot",
    ],
    useCases: [
      "A collaborative whiteboard that deletes itself",
      "Live annotation on a shared page",
      "A classroom sketch room with a hard cap on size and time",
    ],
    tags: ["partyserver", "yjs", "durable-objects", "websockets"],
    source: partyserverFallbackSource,
  },
  {
    slug: "feedlog",
    title: "Feedlog",
    description: "A public feedback board with votes, a roadmap, and duplicate spotting.",
    demonstrates:
      "D1 holds posts, one vote per visitor cookie, and changelog rows. Workers AI embeds the title and body into Vectorize so the compose box can list similar posts. If the index is unavailable, the page falls back to word overlap and says so.",
    capabilities: [
      "Read the seeded ideas, vote once from this browser, and open the roadmap and changelog",
      "Write a post and watch similar posts appear as you type",
      "Attach a JPEG, PNG, GIF, or WebP under 1.5 MB",
      "See the lexical label when Vectorize is not available",
    ],
    useCases: [
      "A public roadmap with one vote per browser",
      "A changelog next to the requests that prompted it",
      "A request form that warns when a near-duplicate already exists",
    ],
    tags: ["d1", "r2", "vectorize", "workers-ai", "turnstile"],
    source: feedlogFallbackSource,
  },
  {
    slug: "company-brain",
    title: "Company Brain",
    description: "A private org memory. Answers cite stored rows, or say they don't know.",
    demonstrates:
      "One Agents SDK Durable Object per sandbox org stores facts and decisions in SQLite. Workers AI answers only from retrieved rows and cites them, or says it does not know. Orgs are not shared, and an alarm wipes the sandbox.",
    capabilities: [
      "Create a private org seeded with a few Northline facts and decisions",
      "Ask a question and see cited fact or decision ids, or a refusal when nothing matches",
      "Add a fact or decision in the memory pane",
      "Ingest a row with the token shown once at creation",
    ],
    useCases: [
      "An onboarding bot that only quotes the rows you loaded",
      "A decision log whose answers cite the source row",
      "A sandbox for the “I don't know” path before you add connectors",
    ],
    tags: ["agents-sdk", "durable-objects", "workers-ai", "turnstile"],
    source: companyBrainFallbackSource,
  },
  {
    slug: "clef-gate",
    title: "Clef Gate",
    description: "A desk where every sandboxed tool call stops for a Clef decision.",
    demonstrates:
      "Every tool call is a choice from Clef or Clef-flash: allow, deny, or ask-human, with probabilities. Ask-human and low-confidence calls wait in the session Durable Object until you approve or deny. The five tools are fakes — nothing is sent, fetched, or deleted — and each verdict is written to D1.",
    capabilities: [
      "Ask the desk to use one of the five sandboxed tools",
      "Read the verdict and the probabilities",
      "Approve or deny a paused call; it resumes in the same Durable Object",
      "Open the audit list for the tool, the decision, and the model",
      "See that send, delete, and SQL tools only describe what they would have done",
    ],
    useCases: [
      "A tool-using agent with a human approval queue",
      "An audit log of model verdicts before a real side effect exists",
      "A gate you can later put in front of mail, SQL, or deletes",
    ],
    tags: ["workers-ai", "agents-sdk", "d1", "durable-objects"],
    source: clefGateFallbackSource,
  },
  {
    slug: "tanbase",
    title: "Tanbase",
    description: "An anonymous kanban. Cards stay in sync across tabs, and a workflow can split one.",
    demonstrates:
      "D1 is the board of record. One hibernating Board Durable Object per board fans creates, moves, edits, and deletes to every open tab. A Workflow splits a card with Workers AI, or writes four fallback subtasks if the model output is unusable. There are no accounts; boards expire after 7 days.",
    capabilities: [
      "Create a board and add, edit, move, and delete cards",
      "Open the same board in another tab and watch the Durable Object sync it",
      "Attach a small file to a card",
      "Split a card and watch the workflow steps, including the fallback subtasks",
    ],
    useCases: [
      "A small shared board that does not need accounts",
      "Live card updates across every open tab",
      "A “split this task” action backed by a Workflow",
    ],
    tags: ["d1", "durable-objects", "r2", "workflows", "workers-ai"],
    source: tanbaseFallbackSource,
  },
  {
    slug: "actor-lab",
    title: "Actor lab",
    description: "A counter race and a chat that show how one Durable Object lines up work.",
    demonstrates:
      "A SQLite-backed actor persists fields through a state proxy, and mailbox handlers run one at a time. An await on Workers AI opens the input gate, so interleaved updates lose increments. The chat actor hibernates; a simulated eviction drops isolate memory and reloads the transcript from SQLite.",
    capabilities: [
      "Arm a race after Turnstile and fire Interleaved: the counter ends below the number of updates",
      "Fire Serialized mailbox: the counter reaches the number of updates",
      "Chat in a room over a hibernating WebSocket",
      "Simulate evict: the scratch note disappears and the SQLite transcript remains",
    ],
    useCases: [
      "A counter or balance that must not lose increments across an await",
      "A chat whose history survives hibernation and a dropped isolate",
      "A bench for teaching the Durable Object input gate",
    ],
    tags: ["durable-objects", "workers-ai", "websockets", "turnstile"],
    source: actorLabFallbackSource,
  },
  {
    slug: "repo-per-agent",
    title: "Repo per agent",
    description: "One agent and one git repo per task. The page shows the commit and the diff.",
    demonstrates:
      "One Agents SDK agent and one Cloudflare Artifacts git repository per task. The agent commits a small file edit through Git smart HTTP. The Artifacts binding creates the repo, reads the tree, and mints a ten-minute read-only clone token. If the model returns the same file, nothing is committed.",
    capabilities: [
      "Create a task after Turnstile and get a fresh Artifacts repo",
      "Run the agent and, when the model changes a file, see the commit",
      "Read the commit log and the unified diff",
      "Mint a ten-minute read-only git clone token",
      "Watch an unchanged model response commit nothing",
    ],
    useCases: [
      "A coding agent with one repo per ticket",
      "A review page that shows the diff before anyone clones",
      "A scratch repo that a cron deletes with its log rows",
    ],
    tags: ["artifacts", "agents-sdk", "workers-ai", "d1", "turnstile"],
    source: repoPerAgentFallbackSource,
  },
];

export function getDemo(slug: string): DemoEntry | undefined {
  return demos.find((d) => d.slug === slug);
}
