# Changelog — edgechat vs Edgechat

This demo is **inspired by** [aozorae/Edgechat](https://github.com/aozorae/Edgechat), not a drop-in fork. Upstream is a self-hostable team chat (GPL-3.0). This repo is a **hosted original demo** that shows Durable Object realtime rooms plus D1 / KV / R2 on Workers Paid, without Workers for Platforms and **without vendoring GPL source**.

## Architecture

| | Edgechat (upstream, idea only) | This demo |
| --- | --- | --- |
| Runtime | One Worker, Hono, Vue client | One Worker, plain `fetch()` router, vanilla TS UI |
| Realtime | `ChannelRoom` + `UserInbox` DOs, WebSocket hibernation | One `ChatRoom` DO, Hibernation API |
| Store | D1 users / channels / messages | D1 `rooms`, `messages`, `attachments` |
| Sessions | KV | KV display-name cookie |
| Files | Encrypted R2 (AES-256-GCM keyring) | Plain R2 put/get |
| Auth | Passwords, session versioning, workspaces | None (public demo names) |
| Bridges | Telegram / Discord | None |
| UI | Upstream Vue app | Graphite & Ember (`#c2410c` on `#0e0e11`), hub LogoMark |
| License of this folder | — | Original code; not a GPL derivative of Edgechat |

## What we cut

- Telegram / Discord (or any) bridges
- Full auth SaaS, invitations, roles, multi-workspace admin
- E2EE / AES keyring / encrypted R2
- `UserInbox` Durable Object, unread projection, typing indicators
- Scheduler GC Durable Object
- Hono, Vue, and any file from the upstream tree
- Workers for Platforms / dispatch namespaces

## What we kept (as an idea, rewritten)

- Named rooms with live fan-out
- History that survives refresh
- A display name that is not the message body
- A file in the thread

## Branding

Hub Graphite & Ember. Ember accent `#c2410c`, background `#0e0e11`. Real LogoMark SVG (cloud + lightning + streaks). No purple-to-cyan logo.
