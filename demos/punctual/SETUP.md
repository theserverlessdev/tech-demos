# Setup — punctual

Self-host office-hours booking on **Workers Paid**. One host, one Worker. Guests get ICS mail (Resend BYOK), can cancel, and you can list upcoming bookings.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/theserverlessdev/tech-demos/tree/main/demos/punctual)

The button clones this folder. **Replace the D1 / KV IDs and routes** with resources on *your* account before the first deploy. The IDs in `wrangler.jsonc` belong to the hosted demo.

This is **not** Workers for Platforms and **not** a multi-tenant SaaS. No Google/Microsoft OAuth in this slice — ICS is the calendar interop.

---

## Hosted demo (owner)

| | |
| --- | --- |
| UI | <https://punctual.tech-demos.theserverless.dev/> and <https://tech-demos.theserverless.dev/demos/punctual/> |
| Worker | `tech-demos-punctual` |
| D1 | `tech-demos-punctual` (`b856b123-57ee-4970-b7bb-e50095670ede`) |
| KV | `tech-demos-punctual-cache` (`d8f2374ceed24d328fe37737b69d42f1`) |
| Queue | `tech-demos-punctual-reminders` |
| Rate limit | `BOOK_LIMIT` namespace `7361` · 20 / 60s |

### Mac deploy (wrangler login)

Cloud agent VMs often have no Wrangler OAuth. From the owner Mac:

```bash
export CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5
unset CF_API_TOKEN CLOUDFLARE_API_TOKEN
cd demos/punctual
bun run deploy
# first time / rotate:
openssl rand -hex 32 | bunx wrangler secret put SIGNING_SECRET
openssl rand -hex 32 | bunx wrangler secret put ADMIN_API_KEY
# optional real mail:
bunx wrangler secret put RESEND_API_KEY
```

Then apply the grow migration if deploy did not: `CI=true bunx wrangler d1 migrations apply DB --remote`.

Set `MAIL_FROM` / `MAIL_FROM_NAME` / `HOST_NOTIFY_EMAIL` / `PUBLIC_ORIGIN` in `wrangler.jsonc` vars (or the dashboard) so confirmation mail and Queue reminder links use the public origin.

Turnstile stays **off** on the hosted demo until you put both `TURNSTILE_SITE_KEY` (var) and `TURNSTILE_SECRET_KEY` (secret).

---

## Self-host (your account)

### 1. Create bindings

```bash
cd demos/punctual
bunx wrangler d1 create tech-demos-punctual          # paste database_id into wrangler.jsonc
bunx wrangler kv namespace create tech-demos-punctual-cache
bunx wrangler queues create tech-demos-punctual-reminders
```

Paste the D1 `database_id` and KV `id` into `wrangler.jsonc`. Keep binding names `DB`, `CACHE`, `REMINDERS`, `CALENDAR`, `BOOK_LIMIT`.

Remove or rewrite the `routes` array (those hostnames are the demo zone). `workers_dev: true` is enough to start.

### 2. Vars (non-secret)

| Var | Example | Meaning |
| --- | --- | --- |
| `HOST_ID` | `ankur` | Durable Object name + D1 `host_id` |
| `HOST_DISPLAY_NAME` | `Ankur Singh` | Shown on the page and in ICS |
| `HOST_TITLE` | `Office hours` | Event title |
| `HOST_TZ` | `America/Los_Angeles` | IANA timezone for slot generation |
| `SLOT_MINUTES` | `30` | Slot length (5–240) |
| `DAY_START` | `09:00` | Inclusive local start |
| `DAY_END` | `17:00` | Exclusive local end |
| `WEEKDAYS` | `Mon,Tue,Wed,Thu,Fri` | Open days |
| `HOST_NOTIFY_EMAIL` | `you@example.com` | Optional host copy of each booking |
| `MAIL_FROM` | `book@yourdomain.com` | Resend from-address (must be a verified domain) |
| `MAIL_FROM_NAME` | `Punctual` | From display name |
| `PUBLIC_ORIGIN` | `https://book.example.com` | Canonical origin for ICS/cancel links in Queue mail |
| `TURNSTILE_SITE_KEY` | *(empty)* | Public widget key. Leave empty to keep Turnstile **off**. |

### 3. Secrets

```bash
openssl rand -hex 32 | bunx wrangler secret put SIGNING_SECRET   # HMAC for ICS + cancel links
openssl rand -hex 32 | bunx wrangler secret put ADMIN_API_KEY    # Bearer for /admin and GET /api/admin/bookings
bunx wrangler secret put RESEND_API_KEY                          # omit → bookings still succeed, mail skipped
# optional:
bunx wrangler secret put TURNSTILE_SECRET_KEY
```

If `RESEND_API_KEY` or `MAIL_FROM` is missing, `POST /api/book` still returns `201`. The UI says email was skipped; `mail_status` / `reminder_status` stay `skipped` once the Queue consumer runs.

### 4. Migrate + deploy

```bash
bun run deploy    # build client, apply D1 migrations remotely, wrangler deploy
```

Migrations: `0001_init.sql` (locks + bookings) then `0002_mail_cancel.sql` (status / mail / cancel).

### 5. Optional Turnstile

Default **off**. To gate `POST /api/book`:

1. Create a [Turnstile widget](https://developers.cloudflare.com/turnstile/get-started/) for your hostname (managed mode).
2. Put the site key in `TURNSTILE_SITE_KEY`.
3. `bunx wrangler secret put TURNSTILE_SECRET_KEY`.
4. Redeploy. The booking form loads the widget only when the site key is set.

Rate limit `BOOK_LIMIT` stays on regardless.

---

## Reminder Queue

Cloudflare Queues delay a message by **at most 24 hours** per hop.

- Target send time = slot start − 24 h.
- Further out: the consumer re-enqueues the remainder.
- Slot already inside 24 h: the first consumer pass sends (or skips if no Resend).
- `reminder_status` is `queued` → `sent` | `skipped` | `failed`. Cancelled bookings mark `skipped`.

---

## Admin list

`GET /api/admin/bookings` and the `/admin` page require `Authorization: Bearer $ADMIN_API_KEY`. If the secret is unset, the API returns `503 admin_disabled`.

Cancel from the list uses the same Bearer (no email token). It deletes the D1 `slot_locks` row and invalidates KV.

---

## Local

```bash
cd demos/punctual
cp .dev.vars.example .dev.vars
bun install
bun run dev          # build, local D1 migrate, wrangler dev
bun run scripts/smoke.ts http://127.0.0.1:8787
```

`.dev.vars` overrides `PUBLIC_ORIGIN` so ICS/cancel links stay on localhost. Leave `RESEND_API_KEY` empty to exercise fail-soft mail.
