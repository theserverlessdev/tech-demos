# Setup — punctual

Self-host office-hours booking on **Workers Paid**. One host, one Worker. Guests get ICS mail (Resend BYOK), can cancel, and you can list upcoming bookings. Optional Google Calendar connect hides busy times and writes events.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/theserverlessdev/tech-demos/tree/main/demos/punctual)

The button clones this folder. **Replace the D1 / KV IDs and routes** with resources on *your* account before the first deploy. The IDs in `wrangler.jsonc` belong to the hosted demo.

This is **not** Workers for Platforms and **not** a multi-tenant SaaS. Microsoft Outlook is out of this slice. ICS remains the calendar interop when Google is unset.

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
# optional Google Calendar:
# bunx wrangler secret put GOOGLE_CLIENT_SECRET
# openssl rand -hex 32 | bunx wrangler secret put TOKEN_ENCRYPTION_KEY
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
| `GOOGLE_CLIENT_ID` | OAuth client id | Public. Leave empty to keep Google **off**. |
| `GOOGLE_MOCK_BUSY` | `[{"start":"…Z","end":"…Z"}]` | Local-only busy intervals when OAuth is unset. |

### 3. Secrets

```bash
openssl rand -hex 32 | bunx wrangler secret put SIGNING_SECRET   # HMAC for ICS + cancel links
openssl rand -hex 32 | bunx wrangler secret put ADMIN_API_KEY    # Bearer for /admin and GET /api/admin/bookings
bunx wrangler secret put RESEND_API_KEY                          # omit → bookings still succeed, mail skipped
# optional:
bunx wrangler secret put TURNSTILE_SECRET_KEY
bunx wrangler secret put GOOGLE_CLIENT_SECRET
openssl rand -hex 32 | bunx wrangler secret put TOKEN_ENCRYPTION_KEY
```

`TOKEN_ENCRYPTION_KEY` encrypts Google refresh/access tokens in D1. If it is unset, the Worker falls back to `SIGNING_SECRET` (documented here so you know). Prefer a dedicated key.

If `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` is missing, OAuth routes return `503 google_disabled`. Availability stays D1-only. Bookings still succeed; `google` on the book response is `skipped`.

If `RESEND_API_KEY` or `MAIL_FROM` is missing, `POST /api/book` still returns `201`. The UI says email was skipped; `mail_status` / `reminder_status` stay `skipped` once the Queue consumer runs.

### 4. Migrate + deploy

```bash
bun run deploy    # build client, apply D1 migrations remotely, wrangler deploy
```

Migrations: `0001_init.sql` → `0002_mail_cancel.sql` → `0003_google.sql` (host tokens + `google_event_id`).

### 5. Optional Turnstile

Default **off**. To gate `POST /api/book`:

1. Create a [Turnstile widget](https://developers.cloudflare.com/turnstile/get-started/) for your hostname (managed mode).
2. Put the site key in `TURNSTILE_SITE_KEY`.
3. `bunx wrangler secret put TURNSTILE_SECRET_KEY`.
4. Redeploy. The booking form loads the widget only when the site key is set.

Rate limit `BOOK_LIMIT` stays on regardless.

### 6. Optional Google Calendar

Default **off**. To connect the host calendar:

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials) create an OAuth **Web application** client.
2. Enable the **Google Calendar API**.
3. Authorized redirect URI (exact):

   `${PUBLIC_ORIGIN}/api/google/callback`

   Examples:

   - `https://punctual.tech-demos.theserverless.dev/api/google/callback`
   - `http://127.0.0.1:8787/api/google/callback` (local)

4. Put the client id in `GOOGLE_CLIENT_ID` (wrangler var). `bunx wrangler secret put GOOGLE_CLIENT_SECRET`.
5. Set `TOKEN_ENCRYPTION_KEY`. Redeploy.
6. Open `/admin`, unlock with `ADMIN_API_KEY`, click **Connect Google**. Scopes: `calendar.freebusy` + `calendar.events`.

When connected:

- `GET /api/availability` hides slots that overlap Google freeBusy (30s KV TTL).
- A successful book creates a Calendar event on `primary` (`google=sent`). If the write fails, the D1 lock still stands (`google=failed`).
- Cancel deletes that event (404 is ignored).

Disconnect from `/admin` deletes the encrypted tokens and invalidates KV.

`GOOGLE_MOCK_BUSY` is a local screenshot/smoke hook only. It hides intervals without OAuth and does not write events.

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
