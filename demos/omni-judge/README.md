# Omni Judge

Live at [tech-demos.theserverless.dev/demos/omni-judge](https://tech-demos.theserverless.dev/demos/omni-judge/) after deploy.

One Workers AI call decides a photo, a voice note, or a short video. Clef-omni returns a probability for every allowed answer. The page can also time the older chain on the same image or audio.

## What this demonstrates

**Pattern.** `@cf/cloudflare/clef-omni` takes the media as a base64 data URL (`images`, `audio`, or `videos`) and a map of choice questions. The response has one answer per question: the chosen option, a probability for each option, and a confidence. There is no transcribe step and no vision step in that call.

**What you can do**

- Snap a photo, record a voice note, or film up to 10 seconds. A voice note is converted to WAV in the browser, because Clef-omni accepts WAV and MP3, not a MediaRecorder WebM audio blob.
- Start from a bundled self-made sample.
- Pick a preset checklist, or write up to five questions with two to six options.
- Read the top answer, a bar for every option, and the latency.
- Compare an image or a voice note with Whisper or Llama 3.2 11B Vision, then Clef.
- Review recent judgments from this browser.

**What you could build**

- Voicemail triage.
- Upload moderation.
- Field-inspection checklists.
- Support-call routing.

**Limits**

- Image ≤ 2 MB (PNG, JPEG, or WebP). Audio ≤ 15 seconds and ≤ 1.5 MB (WAV or MP3). Video ≤ 10 seconds and ≤ 6 MB (MP4 or WebM). The server sniffs the bytes. The declared Content-Type is ignored.
- 8 model actions per browser per hour, 8 per network per hour, and 80 per rolling 24 hours. The network key is an HMAC of the IPv4 address or the IPv6 /64. The address is not stored.
- Burst limits use Workers rate-limit namespaces `7451` (judge), `7452` (compare), and `7453` (read).
- Turnstile runs before any model call. A missing secret, or the test secret on a public host, fails closed.

## What is real

- Workers AI `@cf/cloudflare/clef-omni` when `ENVIRONMENT` is empty. Prices used for the estimate are from the model docs: Clef-omni $0.15 per million input tokens (output tokens are not billed), Clef $0.24 per million input tokens, Whisper large v3 turbo $0.000513 per audio minute, Llama 3.2 11B Vision $0.0485 / $0.676 per million input / output tokens. If a response has no token counts, that dollar amount is omitted, except the Whisper minute price and the documented Clef-omni media-token estimate.
- The classic chain does not run on video. This Worker has no frame extractor, and the vision model reads a still image. The page says so.
- D1 stores judgments. R2 stores uploads under `media/<unguessable id>`. Samples stay in the static assets and are not copied into R2.
- A cron at minute 17 deletes rows whose `expires_at` has passed (24 hours after creation) and the R2 object. A file can outlive the row by up to an hour if a delete fails and the next cron retries it.

### Deletion backstop

After the bucket exists:

```bash
wrangler r2 bucket lifecycle add tech-demos-omni-judge media-expiry media/ --expire-days 1
```

That lifecycle rule is not a field in `wrangler.jsonc`. The cron is the path that also deletes the D1 rows.

## Run locally

```bash
cd demos/omni-judge
cp .dev.vars.example .dev.vars
bun install
bun run dev
```

`bun run dev` uses `wrangler.local.jsonc`, which has no Workers AI binding, and `.dev.vars` sets `ENVIRONMENT=local`. Results are labelled **Local stub. Workers AI was not called.** The Turnstile widget uses Cloudflare’s [always-pass test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/). The dummy token is `XXXX.DUMMY.TOKEN.XXXX`.

`wrangler dev` with the production config needs a logged-in Wrangler session before Workers AI will answer. This PR does not deploy, and it does not call Clef-omni live.

`bun run typecheck` runs `wrangler types` before `tsc`. `bun test` covers sniffing, the budget insert, owner-only reads, and the Clef-omni request and response fixture.

## Deploy

Do not deploy from this PR until the resources below exist. From this folder, with the owner account (unset any other API token):

```bash
bunx wrangler d1 create tech-demos-omni-judge
# paste the database_id over the placeholder in wrangler.jsonc
bunx wrangler r2 bucket create tech-demos-omni-judge
bunx wrangler secret put TURNSTILE_SECRET
bunx wrangler secret put IP_HASH_SECRET
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler deploy
```

A brand-new Worker with `secrets.required` needs a first deploy before `wrangler secret put` works, or a secrets file. `TURNSTILE_SECRET` and `IP_HASH_SECRET` are both required. Put the Turnstile site key in `vars.TURNSTILE_SITE_KEY` (it is `REPLACE_ME` until the widget exists). `workers_dev` is false.

### Resources to create

| Resource | Name | Notes |
| --- | --- | --- |
| D1 database | `tech-demos-omni-judge` | Placeholder `database_id` is `00000000-0000-4000-8000-000000007451`. Create the database and paste the real id into `wrangler.jsonc`. Apply `migrations/0001_init.sql`. |
| R2 bucket | `tech-demos-omni-judge` | Create the bucket, then add the lifecycle rule above. |
| Turnstile widget | `tech-demos-omni-judge` | Hostnames: `tech-demos.theserverless.dev`, `omni-judge.tech-demos.theserverless.dev`. Site key replaces `REPLACE_ME`. Secret via `wrangler secret put TURNSTILE_SECRET`. |
| Secret | `IP_HASH_SECRET` | HMAC key for the network cap. Not a Turnstile value. |
| Rate-limit namespaces | `7451` judge, `7452` compare, `7453` read | Created when this Worker is deployed. They are not used elsewhere in this repo. |
| Routes | `tech-demos.theserverless.dev/demos/omni-judge*` and `omni-judge.tech-demos.theserverless.dev/*` | Zone `theserverless.dev`. Applied on deploy. |
| Cron | `17 * * * *` | Declared in `wrangler.jsonc`. |
| Workers AI | account binding | No extra index. The model id is `@cf/cloudflare/clef-omni`. |

No Durable Object.

Production fails closed when `TURNSTILE_SECRET` or `IP_HASH_SECRET` is missing, and it rejects the always-pass test secret unless `ENVIRONMENT` is `local`.

After the Worker is deployed, redeploy `apps/hub` so the gallery card is not only the fallback redirect. The hub fallback returns 503 when the request is already on `omni-judge.tech-demos.theserverless.dev`.

## Layout

```
src/worker/   HTTP, Turnstile, D1 budget, R2, Clef-omni, comparison
src/client/   capture, checklists, bar charts, history
src/shared/   sniffing, question checks, request build and response parse
public/       Graphite & Ember page and samples
migrations/   media and judgments
test/         caps, budget, owner reads, Clef-omni fixture
```
