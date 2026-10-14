# Omni Judge

Live at [omni-judge.tech-demos.theserverless.dev](https://omni-judge.tech-demos.theserverless.dev/) after deploy. `tech-demos.theserverless.dev/demos/omni-judge` redirects there. The API answers only on the demo host.

One Workers AI call decides a photo, a voice note, or a short video. Clef-omni returns a probability for every allowed answer. The page can also time the older chain on the same image or audio.

## What this demonstrates

**Pattern.** `@cf/cloudflare/clef-omni` takes the media as a base64 data URL (`images`, `audio`, or `videos`) and a map of choice questions. The response has one answer per question: the chosen option, a probability for each option, and a confidence. There is no transcribe step and no vision step in that call.

**What you can do**

- Snap a photo, record a voice note, or film up to 10 seconds. A voice note is converted to 16 kHz WAV in the browser before upload. The model docs describe audio as WAV or MP3.
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

- Image ≤ 2 MB and ≤ 16 megapixels (PNG, JPEG, or WebP). Audio ≤ 15 seconds and ≤ 1.5 MB (WAV or MP3). Video ≤ 10 seconds and ≤ 6 MB (MP4 or WebM), with about 500 ms of slack so a clip stopped near 9.5 seconds still passes. The server sniffs the bytes. The declared Content-Type is ignored. WebM duration is the span from the earliest block timecode to the latest, and TimecodeScale is read only from Segment > Info. An unknown-size cluster is walked element by element and ends at the next segment-level element, not at a Cluster id buried in a Void. A junk byte, an unknown-size element, a second Info, or an unknown-size Info is rejected. An unknown-size cluster cut off as the last bytes of the file keeps the last complete block. A broken element anywhere earlier is rejected, and a known-size cut is rejected. Trailing zero bytes do not end the read early. Bytes after a known-size Segment must be zero padding. MP4 duration is the longest of `mehd`, the `sidx` subsegment durations, and the tracks. Each track is the longer of its edit-list total (movie timescale) and its media timeline. That timeline is the longer of the summed sample durations and the span from the earliest fragment start to the latest end. Sample durations come from `stts` and every `trun` (`trex` fills in a sample duration the fragment omits). In one `traf`, each `trun` continues from `tfdt` plus the preceding truns. The end of a sample includes its `ctts` or `trun` composition offset, converted with the track's `mdhd` timescale. A second `moov`, a repeated track id, a sample table that does not fit, or a track that has samples but no duration is rejected. MP3 duration sums each frame at that frame's sample rate, keeps going after junk, and rounds up only past a fraction of a millisecond. WAV duration uses the first `fmt ` (it has to come before the data) and sums every `data` chunk. The MP4 box walk stops at the parent box and at 50,000 boxes. The Worker sets `limits.cpu_ms` to 2000.
- 8 model actions per browser per hour, 8 per network per hour, and 80 per rolling 24 hours. The network key is an HMAC of the IPv4 address or the IPv6 /56. The address is not stored. The visitor cookie is `__Host-oj_vid` (Secure, Path=/, no Domain).
- Burst limits use Workers rate-limit namespaces `7451` (judge), `7452` (compare), and `7453` (read).
- Turnstile runs before any model call. A missing secret, or the test secret on a public host, fails closed.

## What is real

- Workers AI `@cf/cloudflare/clef-omni` when `ENVIRONMENT` is empty. Prices used for the estimate are from the model docs: Clef-omni $0.15 per million input tokens (output tokens are not billed), Clef $0.24 per million input tokens, Whisper large v3 turbo $0.000513 per audio minute, Llama 3.2 11B Vision $0.0485 / $0.676 per million input / output tokens. If a response has no token counts, that dollar amount is omitted, except the Whisper minute price and the documented Clef-omni media-token estimate.
- The classic chain does not run on video. This Worker has no frame extractor, and the vision model reads a still image. The page says so.
- D1 stores judgments. R2 stores uploads under `media/<unguessable id>`. Samples stay in the static assets and are not copied into R2.
- A cron at minute 17 deletes rows whose `expires_at` has passed (24 hours after creation) and the R2 object. A file can outlive the row by up to an hour if a delete fails and the next cron retries it.

### Deletion backstop

The lifecycle rule is required. It is not a field in `wrangler.jsonc`. The cron is the path that also deletes the D1 rows. If an insert fails after the object is written, the Worker deletes that object.

```bash
wrangler r2 bucket lifecycle add tech-demos-omni-judge media-expiry media/ --expire-days 1
```

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

### Smoke checklist

- `bun test` and `bun run typecheck`.
- `bun run dev`, then `bun run smoke` against the local stub. Results must say the local stub was used.
- A judge POST with no `Content-Length` returns 411, and the judge rate limit runs before the body is parsed or Turnstile is checked.
- Uploads are base64-encoded once with `Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)`, and that string is reused if comparison also needs it. A 6 MB video should not encode the bytes twice.
- The Llama 3.2 11B Vision `image` field in the model schema is an integer array or a binary string. Both forms are deprecated in favor of `messages`. This demo still sends the integer array. Comparison images are also capped at 512 KB and 2 megapixels, which is tighter than the omni image cap.

## Deploy

Do not deploy from this PR until the resources below exist. From this folder, with the owner account (unset any other API token):

```bash
bunx wrangler d1 create tech-demos-omni-judge
# paste the database_id over the placeholder in wrangler.jsonc
bunx wrangler r2 bucket create tech-demos-omni-judge
# required backstop, not a wrangler.jsonc field
bunx wrangler r2 bucket lifecycle add tech-demos-omni-judge media-expiry media/ --expire-days 1
bunx wrangler secret put TURNSTILE_SECRET
bunx wrangler secret put IP_HASH_SECRET
# one-time, before image comparison. The owner runs this. It agrees to Meta's license.
curl "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/meta/llama-3.2-11b-vision-instruct" \
  -X POST \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -d '{ "prompt": "agree" }'
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler deploy
```

A brand-new Worker with `secrets.required` needs a first deploy before `wrangler secret put` works, or a secrets file. `TURNSTILE_SECRET` and `IP_HASH_SECRET` are both required. Put the Turnstile site key in `vars.TURNSTILE_SITE_KEY` (it is `REPLACE_ME` until the widget exists). `workers_dev` is false.

### Resources to create

| Resource | Name | Notes |
| --- | --- | --- |
| D1 database | `tech-demos-omni-judge` | Placeholder `database_id` is `00000000-0000-4000-8000-000000007451`. Create the database and paste the real id into `wrangler.jsonc`. Apply `migrations/0001_init.sql` and `migrations/0002_pair.sql`. |
| R2 bucket | `tech-demos-omni-judge` | Create the bucket, then add the lifecycle rule above. Deploy is not complete without that rule. |
| Turnstile widget | `tech-demos-omni-judge` | Hostname `omni-judge.tech-demos.theserverless.dev`. The hub path redirects before the widget loads. Site key replaces `REPLACE_ME`. Secret via `wrangler secret put TURNSTILE_SECRET`. |
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
