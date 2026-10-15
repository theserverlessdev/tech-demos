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
| Expiry | None by default | Alarm two hours after create. `deleteAll` (compat date `2026-09-01` also clears the alarm). A wake with no `meta` also `deleteAll`. |
| Admission | None by default | Turnstile + `CREATE_LIMIT` on create. HMAC room id + `CONNECT_LIMIT` on upgrade. `READ_LIMIT` on status GET. 8 sockets, 240 strokes, 256 KB, per-connection frame meter. Caps are a server `afterTransaction` guard, not `isReadOnly`. |
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

## 2026-10-15

Audit fixes (B1–B3, S1–S7, N1–N11) and PR #39 follow-ups:

- HMAC-tagged room ids (key derived from `ROOM_SECRET`, or from `TURNSTILE_SECRET` if that is unset), `READ_LIMIT` on status GET, party HTTP 404, `deleteAll` on unknown rooms and on the TTL alarm.
- Caps stay writable: `isReadOnly` is always false. Invalid strokes, extra keys, list items under the strokes map, and foreign root types are dropped in a GUARD transaction so erases sync. Sync step-2 and update frames are inspected with `Y.decodeUpdate` (junk keys, list items, foreign roots, skip-ahead) and the socket is closed on reject. Pending structs are cleared after apply. The size cap trims only incoming strokes, never existing ink. A rejected 9th socket cannot write.
- Fatal closes (full, expired, unknown, rate/frame) keep their message. The canvas and tools then stop accepting input.
- 4:3 logical board with a uniform scale. Phone portrait canvas uses `aspect-ratio: 4/3` and `max-height: 62dvh`. Landscape keeps the board and tools side by side and lets the canvas fill the remaining height (no fixed strip subtraction). Long strokes commit a chunk and continue instead of dropping the head.
- Copy, route patterns, Turnstile test-host carve-out, presence validation, and 44px phone fields match the code.

## 2026-10-09

Phone layout: 16px fields, 44px ink controls, and safe-area padding. Drawing uses pointer events with touch-action none so a finger does not scroll the page. The header keeps the Partyboard title on a second row instead of hiding it.
