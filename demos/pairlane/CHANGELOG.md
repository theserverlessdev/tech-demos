# Changelog — pairlane vs kiyo-e/pairlane

This demo is inspired by [kiyo-e/pairlane](https://github.com/kiyo-e/pairlane) (MIT). Upstream is a Vite SSR app with a CLI, a multi-receiver queue, and optional AES-GCM. This folder is an original two-browser room on Workers Paid.

We did not copy upstream `src/room.ts`, `src/client/room.tsx`, the CLI, or the locale files. The MIT notice is in [NOTICE.md](./NOTICE.md).

## Architecture

| | Pairlane (upstream) | This demo |
| --- | --- | --- |
| Runtime | Vite SSR, Hono, assets from `dist/client` | One Worker, `fetch()` router, Static Assets |
| Peers | One sender, many receivers, a queue | Two peers, then the room is full |
| Lifetime | Room lives until it is empty | Alarm closes the room after 10 minutes |
| ICE | Caller-supplied servers | `stun:stun.cloudflare.com:3478`, TURN only if secrets are set |
| UI | i18n, encryption key in the URL hash | Graphite & Ember, QR code, signalling tape |
| Abuse controls | One rate limit on create | Turnstile, per-IP limits, UTC-day cap, per-socket signalling budget |

## What we cut

- The Rust CLI and multi-receiver queue
- Vite, Hono, and the locale packs
- AES-GCM and the `#k=` fragment
- Workers for Platforms

## What we kept

- A Durable Object that only relays WebRTC signalling
- A data channel named for the file, with SHA-256 checked in the browser
- A short room code shared as a link

## What we added

- A hard cap of two peers
- A per-socket signalling budget. Rejected frames are not stored, and the tape is written in batches
- A 10-minute alarm
- The shared Turnstile widget on room creation
- A side panel of signalling messages, with sizes and ICE types, and no file bytes
- Optional TURN, off by default
