# Changelog — feedlog vs Feedlog

This demo is a slice of [linkcraftstudio/feedlog](https://github.com/linkcraftstudio/feedlog) (MIT, by linkcraftstudio), not a drop-in fork. Upstream is a self-hosted feedback, roadmap, and changelog product. This repo is a **hosted demo** of the same visitor loop on Workers Paid, without Workers for Platforms.

The product note: <https://x.com/ceoplanet519/status/2087056479459119500>.

## Architecture

| | Feedlog (upstream) | This demo |
| --- | --- | --- |
| Runtime | Nuxt 4, Vue, Drizzle, Tailwind, shadcn-vue | One Worker, plain `fetch()` router, vanilla TS |
| Store | Postgres 17 + pgvector, often via Hyperdrive | D1: `posts`, `votes`, `changelog` |
| Similar ideas | OpenAI `text-embedding-3-large` (768) | Workers AI `@cf/baai/bge-small-en-v1.5` (384) + Vectorize cosine |
| Auth | better-auth: email, Google, GitHub, admin role | Anonymous visitor cookie. `ADMIN_TOKEN` for status and changelog |
| Files | R2 on the Workers deploy path | R2 images with a type allowlist, size cap, and magic-byte check |
| Boards | Public or private, categories, comments | One public board. No comments |
| Roadmap | Drag and drop | Three columns: planned, in progress, done |
| Changelog | AI-drafted style presets | Admin-written entries only |
| Abuse | App-level | Turnstile on create, upload, and similar. Workers rate-limit bindings on post, vote, similar, and admin |
| Retention | Account data | Visitor posts expire after 14 days. Cron deletes rows, images, and vectors. Cap of 80 visible posts |

## What we cut

- Nuxt, Vue, Drizzle, Tailwind, shadcn-vue
- Postgres, pgvector, Hyperdrive, Neon, Supabase
- OpenAI embeddings and AI changelog drafts
- better-auth, OAuth, email login, admin roles
- Comments and Markdown threads
- Multiple boards, private boards, categories
- Drag-and-drop roadmap and merging duplicates into one post
- Email when a voted post ships
- Workers for Platforms / dispatch namespaces

## What we kept (simplified)

- A public board with title, body, votes, and status
- One vote per visitor per post (a second click removes it)
- Roadmap columns for planned, in progress, and done
- A changelog page
- Duplicate spotting while the visitor types
- An admin path for triage and release notes

## Branding

Hub Graphite & Ember. Ember accent `#c2410c`, background `#0e0e11`. The hub mark. Contact links to theserverless.dev. No purple-to-cyan gradient.

## Local similarity

Vectorize has no local simulation, and Workers AI needs an account. When either call throws, `/api/similar` answers with `source: "lexical"` (word overlap against D1) and the page says so. Production uses `source: "vectorize"` when the bindings respond.

## 2026-10-09

Phone layout: 16px fields, 44px filters and buttons, wrapping tabs, a stacked top bar, and safe-area padding. The board and roadmap already stack on a narrow screen.
