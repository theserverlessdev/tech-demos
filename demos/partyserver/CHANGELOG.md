# Changelog — partyserver vs PartyKit

This demo is an inspired-by slice of [cloudflare/partykit](https://github.com/cloudflare/partykit) (ISC; originally Sunil Pai / threepointone). It depends on the published `partyserver`, `y-partyserver`, and `partysocket` packages. It does not vendor the partykit monorepo, partysub, or partywhen.

Prompt: [@_thebluebutter](https://x.com/_thebluebutter/status/2105331683000234478).

## Architecture

| | PartyKit / PartyServer | This demo |
| --- | --- | --- |
| Room runtime | `Server` Durable Object, optional hibernation | `BoardRoom extends YServer`, `hibernate: true` |
| Routing | `routePartykitRequest` at `/parties/:party/:room` | Same, plus the hub prefix `/demos/partyserver` |
| Shared state | App chooses the messages | Yjs map of ink strokes via `y-partyserver` |
| Presence | App-defined | Yjs awareness (name, colour, cursor). Not written to storage |
| Persistence | `onLoad` / `onSave` hooks, caller-supplied | Snapshot in DO storage. Flushed on save debounce and when a socket closes |
| Expiry | None by default | Alarm two hours after create. `deleteAll`, then a `dead` flag so a late save cannot resurrect the room |
| Admission | None by default | Turnstile + `CREATE_LIMIT` on create. `CONNECT_LIMIT` on upgrade. 8 sockets, 240 strokes, 256 KB, per-connection frame meter |
| Client | `partysocket` / `YProvider` | `YProvider` with BroadcastChannel off, so two tabs only meet on the Durable Object |
| UI | PartyKit marketing and fixtures | Graphite & Ember canvas. Contact links to the hub's site |

## What we cut

- partysub, partywhen, and the rest of the partykit monorepo
- PartyKit's hosted project model, rooms-as-a-service dashboard, and multi-party bindings
- Accounts, passwords, and stored display names
- Chat transcript, file uploads, and Workers AI
- D1, KV, and R2
- Workers for Platforms / dispatch namespaces

## What we kept (simplified)

- Hibernating WebSocket rooms addressed by name
- Yjs document sync and awareness, including a reload from Durable Object storage
- A single static page served by the same Worker

## Branding

Hub Graphite & Ember. Ember accent `#c2410c`, background `#0e0e11`. LogoMark SVG. No purple-to-cyan gradient.

## Known library behaviour

`y-partyserver` debounces `onSave` with `setTimeout`. A Durable Object cannot hibernate while that timer is pending. After the debounce settles (at most `debounceMaxWait`, 800 ms here) and the sockets are idle, hibernation can proceed. Local `wrangler dev` does not hibernate; the `hibernate: true` flag is what production uses.
