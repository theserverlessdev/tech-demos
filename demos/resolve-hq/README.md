# ResolveHQ slice

A shared support inbox on Cloudflare Workers. This is a **small demo** inspired by [mirza-rizvi/ResolveHQ](https://github.com/mirza-rizvi/ResolveHQ), not a fork of that app.

- **Live:** <https://tech-demos.theserverless.dev/demos/resolve-hq/>
- **Subdomain:** <https://resolve-hq.tech-demos.theserverless.dev/>
- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs upstream:** [CHANGELOG.md](./CHANGELOG.md)

Walkthrough stills and a short video: [artifacts/](./artifacts/).

## What it proves

| Binding | What the demo does with it |
| --- | --- |
| **D1** | Tickets and messages (status, priority, assignee stub, timestamps). Five seeded conversations. |
| **R2** | Attach a file to a ticket; list and download. Ticket `#1042` ships with a seeded invoice note. |
| **Queues** | **Simulate inbound** enqueues a customer email. The consumer creates a ticket or appends to a thread. No live Email Routing MX. |
| **Workers AI** | **Draft reply** fills the composer from ticket context. If the model is down, the button fails soft. |

The UI is three panes: ticket list, thread, reply composer. Graphite & Ember branding matches the hub (ember `#c2410c`, background `#0e0e11`, LogoMark SVG).

## How it works

```text
browser ── HTTPS ──► Worker
                      ├─ /api/tickets* ──────────► D1
                      ├─ attachments ────────────► D1 meta + R2 bytes
                      ├─ POST /api/inbound ──────► Queue.send
                      └─ POST …/draft ───────────► Workers AI (fail soft)

Queue consumer ──► create ticket or append message in D1
```

Email Routing is **not** wired on day one. The Queue is the inbound path. A later slice can add `email()` on a throwaway zone; do not touch apex MX on `theserverless.dev` (Google Workspace).

## Local

```bash
cd demos/resolve-hq
bun install
bun run dev
```

Then `bun run scripts/smoke.ts http://127.0.0.1:8787`.

## Deploy

Needs D1, R2, a Queue, and Workers AI (Paid). From this folder, with the owner account (unset any other `CF_API_TOKEN`):

```bash
wrangler d1 create tech-demos-resolve-hq
wrangler r2 bucket create tech-demos-resolve-hq
wrangler queues create tech-demos-resolve-hq-inbound
# put the D1 id into wrangler.jsonc, then:
bun run deploy
```

Routes:

- `tech-demos.theserverless.dev/demos/resolve-hq*`
- `resolve-hq.tech-demos.theserverless.dev/*`

The hub registry keeps a fallback Dynamic Worker that redirects to the subdomain if the zone route is missing.
