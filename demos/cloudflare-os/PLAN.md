# Plan — cloudflare-os

## Goal

Build a small, faithful slice of [Cloudflare OS](https://github.com/cloudflare/cloudflare-os). A visitor
opens a workspace, asks the agent for a gadget or clicks a blueprint, and the gadget runs in its own
Dynamic Worker. The gadget stores state in its own Durable Object facet.

## The slice and the full upstream product

Upstream is a pnpm monorepo with about 30 packages. This demo keeps the architecture that makes Cloudflare
OS different. It does not keep the product features around that architecture.

| Upstream part | Upstream implementation | This slice |
|---|---|---|
| Workspace | `OverseerDurableObject`, typed KV storage, git object store | `Workspace` Durable Object with SQLite tables |
| Gadget server | `server.js` exports `class Gadget extends DurableObject`, loaded with `env.LOADER.get()` and hosted with `ctx.facets.get()` | Same pattern. Each gadget gets its own facet and its own SQLite database |
| Gadget client | `client.js` in a sandboxed `srcdoc` iframe with a strict CSP. The iframe gets a Cap'n Web stub called `gadget` over a `MessagePort` | Same pattern. The shell injects Cap'n Web as a `data:` module |
| Shell to backend | One Cap'n Web WebSocket. Subscriptions use callback stubs | Same pattern |
| Gatekeepers | One Worker for each service (GitHub, Slack, and more), with OAuth, an action journal, and approvals | Two in-process gatekeepers: `WEB` (read-only HTTP to an allowlist) and `AI` (metered Workers AI). Each read goes to an approval queue |
| Egress | `globalOutbound: null`. Bindings are the only path out | Same pattern |
| Blueprints | KV and R2 storage, with `blueprint.json` manifests | Four blueprints bundled into the Worker: Slides, Tic-tac-toe, Pixel Board, Headlines |
| Agent | `pi-agent-core`, many providers, file tools, Code Mode | Workers AI `@cf/zai-org/glm-5.3-flash` with tools. The agent can create gadgets, call gadget methods, and write gadget code |
| Code edits | OT change stream, proposed changes, git merge | The Code tab saves files, increments the version, and restarts the facet. The facet storage stays |
| Auth, sharing, users | OAuth login, `UserDurableObject`, ACLs | The workspace link is the capability. No login |

These upstream items are not in this slice:

- git history and OT editing
- OAuth gatekeepers and exports (PDF and HTML)
- hooks with `ctx.restore()`, Code Mode, and tail workers
- the Kumo React UI and the multi-provider model picker

## MVP scope for one user

- In scope:
  - The Graphite and Ember workspace shell: chat pane, gadget tabs (App, Code, Connections, Storage), Activity, and a live RPC trace.
  - Durable Object workspaces with live multi-tab sync and presence.
  - Gadgets in Dynamic Workers and facets, with sandboxed UIs over Cap'n Web.
  - A gatekeeper approval queue.
  - An agent with tool calls.
- Out of scope: accounts, a saved browser layout, and file history.

## Architecture

```
browser shell ──Cap'n Web WebSocket──▶ Worker (PublicApi)
      │                                   │ Workers RPC
      │ MessagePort (Cap'n Web)           ▼
sandboxed iframe (client.js) ◀───── Workspace DO (SQLite: gadgets, files, chat, actions)
                                          │ ctx.facets.get("gadgetN")
                                          ▼
                              Dynamic Worker (server.js) — class Gadget — own SQLite
                                          │ env.WEB / env.AI (loopback WorkerEntrypoints)
                                          ▼
                                   Gatekeeper → approval queue → fetch / Workers AI
```

- **Isolation.** Each gadget has `globalOutbound: null` and a CPU limit. The iframe has
  `sandbox="allow-scripts"`, which gives it an opaque origin, and a CSP with `connect-src 'none'`.
- **Loader IDs.** A gadget without bindings uses a content-hash ID. Visitors who run the same blueprint
  share one Dynamic Worker, which keeps the unique Dynamic Worker count low. A gadget with bindings uses
  an ID from the workspace, gadget, and version, because the binding props hold its identity.
- **Hot reload.** A code change increments the version and calls `ctx.facets.abort()`. The next call
  loads the new code on the same SQLite database.

## Tasks

1. Worker and routing: static assets, a base path for `/demos/cloudflare-os`, the Cap'n Web `/api` endpoint.
2. `Workspace` DO: schema, snapshots and subscribers, presence, gadget CRUD, facet loader, storage inspector.
3. Gatekeepers: `WebGatekeeper` with an allowlist and approvals, and `AiGatekeeper` with metering.
4. Agent loop on Workers AI with tools, a per-IP rate limit, and a global daily budget.
5. Blueprints: Slides, Tic-tac-toe, Pixel Board, Headlines.
6. Shell UI in vanilla TypeScript, bundled with Bun.
7. Deploy, register in the hub, record a screenshot and a video.

## Stack

- **Workers, Static Assets, Durable Objects (SQLite).** These are the upstream primitives, and the Paid plan includes them.
- **Dynamic Worker Loader and Durable Object Facets.** They are the core of Cloudflare OS. Both are in open beta on Paid.
- **`capnweb` 0.12.0.** It is the same RPC library and version as upstream. It has no dependencies.
- **Workers AI `glm-5.3-flash`.** It supports tool calls and costs little ($0.15 per M input tokens, $0.50 per M output tokens).
- **Workers Rate Limiting binding.** It sets a per-IP limit on agent turns at no extra cost.
- **Vanilla TypeScript for the shell.** The surface is small, so the demo does not need React.

## Cost guards

- The `Meter` DO holds a global daily AI budget (`AI_DAILY_BUDGET_USD`, default `0.15`). The worst case is
  less than $5 each month.
- The rate limit is 6 agent turns per minute per IP. Each workspace can have 8 gadgets or fewer.
- Blueprint gadgets share Dynamic Workers by content hash.
- Visitors can save gadget code, and each new code version is a new Dynamic Worker ID. The `Meter` DO
  caps new IDs at `DYNAMIC_WORKER_DAILY_CAP` (default `60`) each day. Each gadget Worker also has a CPU limit
  of 500 ms and a limit of 50 subrequests.
- The demo uses no Containers, no Browser Rendering, and no Workers for Platforms.

## Deploy

A standalone Worker, `tech-demos-cloudflare-os`, needs Durable Objects, AI, and a Worker Loader, so the hub
loader cannot host it. The Worker has these routes:

- `tech-demos.theserverless.dev/demos/cloudflare-os*` (zone route)
- `cloudflare-os.tech-demos.theserverless.dev/*` (zone route)

The hub registry entry keeps a fallback Dynamic Worker source. That source redirects to the subdomain.

## Testing

- `bun run typecheck` for the Worker and the client.
- A smoke script that connects over Cap'n Web, creates each blueprint, and calls one method on each.
- A manual pass with Playwright for the screenshot and the video.

## Deferred

- Code Mode (`executeCode` through `LOADER.load`).
- OT editing and git history.
- OAuth gatekeepers.
- Export.
