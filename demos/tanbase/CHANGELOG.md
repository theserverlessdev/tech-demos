# Changelog — tanbase vs TanBase Core

This demo is a slice of [tanfust/tanbase-core](https://github.com/tanfust/tanbase-core) (MIT, by tanfust), not a drop-in fork. Upstream is a TanStack Start foundation you fork and own. This repo is a **hosted demo** of the board's Cloudflare binding story on Workers Paid, without Workers for Platforms.

The upstream post: <https://x.com/wassimbenr/status/2104630626758652327>.

## Architecture

| | TanBase Core | This demo |
| --- | --- | --- |
| Runtime | TanStack Start, React 19, Vite, one Worker | One Worker, plain `fetch()` router, vanilla TS UI |
| Store | D1 via Drizzle: projects, tasks, auth, AI usage | D1: `visitors`, `boards`, `tasks`, `attachments`, `reminders`, `splits` |
| Auth | Better Auth, sessions, OAuth for MCP | Anonymous `tb_vid` cookie. Max 3 boards, 40 cards, 7-day TTL |
| Turnstile | Sign-up and sign-in | Create board, upload, and AI split. Fail closed without `TURNSTILE_SECRET` |
| Files | R2, 10 MB, streamed | R2, 256 KB, sniffed allowlist, deleted with the board |
| Live board | `BoardRoom` Durable Object, hibernating WebSockets | Same idea: one DO per board, `ctx.acceptWebSocket` |
| Reminders | Hourly cron → Queue → Email Service | Hourly cron sets `overdue` and writes a log line. No email, no queue |
| AI split | Workflow, Workers AI through AI Gateway, 3–7 subtasks, daily quota | Workflow, Workers AI binding, 3–6 subtasks. Steps stored in D1 for the drawer. Fallback subtasks if the model output is unusable |
| Extra | MCP OAuth, blog, OG images, TanStack Table / Charts / Form / Query | Cut |

## What we cut

- TanStack Start, Router, Query, Form, Table, Charts, Markdown, and Devtools
- React, Drizzle, Zod, Tailwind, and shadcn/ui
- Better Auth, accounts, and sessions
- Email Service, the reminder queue, and verification mail
- MCP server and OAuth 2.1
- Blog, RSS, and link-preview images
- AI Gateway and per-user daily Neuron accounting
- Workers for Platforms / dispatch namespaces

## What we kept (simplified)

- A board of cards you can add, edit, and move
- Files on the card
- Live updates across tabs from one Durable Object
- A Workflow that splits one card into subtasks, with the steps visible
- A due date that the cron can mark, without sending mail
- Turnstile and per-IP rate limits on the expensive writes

## Branding

Hub Graphite & Ember. Ember accent `#c2410c`, background `#0e0e11`. Bricolage Grotesque and Hanken Grotesk. Contact links to theserverless.dev. No purple-to-cyan gradient.
