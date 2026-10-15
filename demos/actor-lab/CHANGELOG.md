# Changelog — actor-lab vs durable-actors

This demo is an inspired-by slice of [TerseAI/durable-actors](https://github.com/TerseAI/durable-actors) (MIT, © 2026 Terse). Upstream is a separate actor runtime you self-host. This repo is a **hosted demo** of the same ergonomics on Cloudflare Durable Objects. The note that pointed at the project: <https://x.com/karatzas_thomas/status/2107872102829502622>.

## Architecture

| | durable-actors (upstream) | This demo |
| --- | --- | --- |
| Runtime | Their server, self-hosted on GCP. Not Durable Objects. | One Worker plus two SQLite Durable Object classes |
| Persisted fields | `@Persisted`, committed when the call succeeds | `state` proxy, each assignment flushed to SQLite |
| Ephemeral fields | `@Ephemeral`, dropped when the actor shuts down | Chat scratch in isolate memory. Simulate evict clears it. |
| Concurrency | One call at a time. `@Interleave` lets other calls run during `await` | Mailbox vs interleaved toggle. The await is Workers AI, which opens the DO input gate |
| Failure | A failed call rolls back field and SQLite changes, until any method uses `@Interleave` | No method-level rollback. The output gate still holds the response until the write is confirmed |
| Load | Their runtime starts the actor | `blockConcurrencyWhile` only while SQLite is loaded into memory |
| Sockets | Grants, tags, auto ping/pong, broadcast | Hibernatable WebSockets, auto ping/pong, broadcast |
| AI | OpenAI through the AI SDK | Workers AI `@cf/meta/llama-3.2-1b-instruct`. Fail soft to a labelled delay or a canned reply |
| Clients | Generated TypeScript and Python stubs | Hand-rolled HTTP and WebSocket JSON |
| Auth | Backend issues a socket grant | Anonymous cookie for the race actor. Room code is the chat capability. Turnstile on AI |
| Limits | `@Compute` CPU / memory hints | Workers rate limits, bounded N, 40 messages, 8 sockets, 6-hour alarm |

## What we cut

- The upstream runtime, GCP self-host, and Python SDK
- Generated clients, `@Emittable` state fan-out, `@Compute`
- OpenAI and the AI SDK
- Method-end commit and rollback
- A real isolate-eviction API (Cloudflare does not expose one)
- Workers for Platforms, Containers, Browser Run

## What we kept (simplified)

- An actor whose fields survive a restart
- Handlers that do not interleave unless you opt in
- A multiplayer AI chat whose transcript survives the actor going away
- A field that is gone after shutdown (the scratch note)
- Per-actor SQLite

## Branding

Hub Graphite & Ember. Ember accent `#c2410c`, background `#0e0e11`, Bricolage Grotesque and Hanken Grotesk. Contact links to theserverless.dev. No purple-to-cyan gradient.

## 2026-10-14

Opus audit of `192a789`:

- `#turnstile` no longer shadows `window.turnstile`. `?room=` joins before the widget mounts. Same id fix in personal-agent.
- GET `/api/rooms/:code` and GET `/api/race/result` are rate-limited. A minted cookie does not create a race actor. Tables and alarms are lazy. Expiry calls `deleteAll()`.
- WebSocket say uses `CHAT_LIMIT` per IP. Scratch is not charged to `CHAT_LIMIT`; each socket may send 12 scratch frames per 10s and extras are dropped. More than 60 frames in 10s — scratch, junk, or say — closes with 1008. The page sends about one scratch frame per second. Scratch broadcasts coalesce. The per-room say window is SQLite. `AI_LIMIT` runs before every model call.
- Turnstile actions are `race-arm` and `chat-unlock`. An empty action is rejected. Hosts are exact. Production has `workers_dev: false`. The widget resets after every send.
- Peers count uses `livePeers()` (OPEN sockets only).
- Copy, 44px targets, scoped inputs, CSP nonce + WebKit `child-src`/`wasm-unsafe-eval`, reconnect with backoff (stops on `Room expired` or after 5 tries; a 429 is not "Room is gone"), reserved name `Actor`. Stored actor lines keep the name Actor across wake and evict.

## 2026-10-09

Phone layout: 16px fields, 44px race buttons, a wrapping composer, and safe-area padding. The trace table scrolls inside its own box.
