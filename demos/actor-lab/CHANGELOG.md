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
