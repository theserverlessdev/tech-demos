# Actor lab

A Durable Object actor with auto-persisted fields and a one-at-a-time mailbox. This is a **small demo** inspired by [TerseAI/durable-actors](https://github.com/TerseAI/durable-actors) (MIT, by TerseAI), not a port of that runtime. The note that pointed at it: [karatzas_thomas on X](https://x.com/karatzas_thomas/status/2107872102829502622).

- **Live:** <https://tech-demos.theserverless.dev/demos/actor-lab/>
- **Subdomain:** <https://actor-lab.tech-demos.theserverless.dev/>
- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs upstream:** [CHANGELOG.md](./CHANGELOG.md)

Walkthrough stills and a short video: [artifacts/](./artifacts/).

## What it proves

| Binding | What the demo does with it |
| --- | --- |
| **Durable Objects (SQLite)** | One race actor per visitor cookie, one chat actor per room code. A `state` proxy writes fields to SQLite. Handlers on the mailbox run one at a time. |
| **Workers AI** | Each race update awaits the model between the read and the write, which opens the input gate. The room actor can answer after a Turnstile unlock. |
| **Hibernatable WebSockets** | The room stays connected across hibernation. A raw `ping` is answered without waking the actor. |
| **Rate limiting** | `RACE_LIMIT` and `CHAT_LIMIT`, 30 requests a minute per IP. |
| **Turnstile** | Required to arm a race and to unlock chat AI. AI routes fail closed in production until a real secret is set. |
| **Alarms** | Actor rows are deleted after 6 hours idle. |

Fire **Interleaved** and the counter ends below the number of updates: several racers read the same value while the model is in flight. Fire **Serialized mailbox** and the counter reaches N. The chat scratch note is only in isolate memory. **Simulate evict** drops it and reloads the transcript from SQLite. Refresh alone does not.

## How it works

```text
browser ── HTTPS ──► Worker
                      ├─ POST /api/race/arm ─► Turnstile, then RaceActor
                      ├─ N × POST /api/race/step ─► read, Workers AI, write
                      └─ WebSocket /api/rooms/:code/socket ─► ChatActor

RaceActor / ChatActor ── SQLite fields
                      └─ await Workers AI (input gate opens)
```

`blockConcurrencyWhile` runs only while the actor loads SQLite. The mailbox, not that call, serializes race handlers. Wrapping the model wait in `blockConcurrencyWhile` would stall every other event on the actor for as long as the model takes.

Cloudflare resources are prefixed `tech-demos-actor-lab` so they do not collide with other demos in this repo.

## Local

```bash
cd demos/actor-lab
cp .dev.vars.example .dev.vars
bun install
bun run dev
```

`.dev.vars` holds Cloudflare's published always-pass Turnstile test secret (`1x0000000000000000000000000000000AA`). The site key in `wrangler.jsonc` is the matching test key (`1x00000000000000000000AA`). Smoke posts the dummy token `XXXX.DUMMY.TOKEN.XXXX`.

Then, with the dev server up:

```bash
bun run scripts/smoke.ts http://127.0.0.1:8787
```

`bun run dev` uses `wrangler.dev.jsonc`, which omits the Workers AI binding. Wrangler will not start a local session that includes that binding until you log in, because the binding is remote-only. Local races then wait on a labelled 300 ms pause, and chat replies use a canned line. The interleaving still happens, because that pause is a non-storage await. `bun run dev:ai` uses `wrangler.jsonc` and the real model after `wrangler login`. Deploy always includes the binding.

## Secrets

| Name | Where | What |
| --- | --- | --- |
| `TURNSTILE_SITE_KEY` | `wrangler.jsonc` `vars` (public) | Widget site key. The committed value is the always-pass **test** key. |
| `TURNSTILE_SECRET` | `wrangler secret put` / `.dev.vars` | Widget secret. Never commit a real one. |

On any host that is not localhost, AI routes stay **off** when the secret is missing or when either value is still a test key. Human chat keeps working.

Create a Turnstile widget for `tech-demos.theserverless.dev` and `actor-lab.tech-demos.theserverless.dev`, put its site key in `wrangler.jsonc`, then:

```bash
cd demos/actor-lab
bunx wrangler secret put TURNSTILE_SECRET
```

## Deploy

Needs Workers Paid (Durable Objects SQLite, Workers AI, rate limiting, Turnstile). No D1, R2, or queues. From this folder, with the owner account (unset any other `CF_API_TOKEN`):

```bash
cd demos/actor-lab
bunx wrangler whoami
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler deploy
```

The first deploy creates the SQLite Durable Object classes from the `v1` migration. Rate limit namespace ids are `7351` (race) and `7352` (chat); they must stay unique in the account.

Routes:

- `tech-demos.theserverless.dev/demos/actor-lab*`
- `actor-lab.tech-demos.theserverless.dev/*`

After the worker is on those routes, redeploy the hub so the gallery card is registered:

```bash
cd apps/hub
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler deploy
```

The hub registry keeps a fallback Dynamic Worker that redirects to the subdomain if the zone route is missing.

## Owner steps if this environment could not deploy

1. `bunx wrangler whoami` with the owner account.
2. Replace `TURNSTILE_SITE_KEY` with a real widget site key.
3. `bunx wrangler secret put TURNSTILE_SECRET`.
4. Deploy this worker with the command above.
5. Redeploy `apps/hub`.
6. Open <https://tech-demos.theserverless.dev/demos/actor-lab/>, fire both race modes, send a chat line, write a scratch note, and press **Simulate evict**.
