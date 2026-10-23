# Edge browser

Live at [tech-demos.theserverless.dev/demos/edge-browser](https://tech-demos.theserverless.dev/demos/edge-browser/) after deploy.

Paste a public URL. A Workflow drives headless Chrome and stores a desktop screenshot, a 390px phone screenshot, a PDF, markdown, and a short summary.

Inspired by [cloudflare/puppeteer](https://github.com/cloudflare/puppeteer), Cloudflare's Puppeteer fork for [Browser Rendering](https://developers.cloudflare.com/browser-run/). This demo calls that library from a Worker. It does not vendor the repo.

## What this demonstrates

**Pattern.** A Worker on the Workers Paid plan drives headless Chrome through the Browser Rendering binding and `@cloudflare/puppeteer`. A Workflow takes a desktop screenshot, a 390px phone screenshot, a PDF, and markdown, then Workers AI summarizes it. Warm reuse asks `puppeteer.sessions()`, newest `startTime` first, then `connect()`, then `Target.getBrowserContexts`. A session under the context cap is disconnected and left warm. Otherwise the step launches a browser with a short `keep_alive` and disconnects it. There is no Durable Object. There are no Containers and no Workers for Platforms.

**What you can do**

- Paste a URL, pass Turnstile, and watch each workflow step.
- Scroll the desktop and phone screenshots inside the frame.
- Open the PDF, read the markdown, and read the summary.
- See whether the capture reused the warm session or launched a browser.
- Try a blocked address and read the SSRF rejection.

**What you could build**

- Link previews that store a screenshot and a short summary.
- Page archiving with a PDF and markdown kept for a day.
- Visual regression checks from a desktop shot and a 390px shot.
- A scraping step that turns a page into markdown for RAG.

**Limits**

- Six captures per browser per hour, six per IPv4 address or IPv6 /64 per hour, and 20 per IPv6 /48 per hour. Those keys are an HMAC with `IP_HASH_SECRET`. The address itself is not stored. The insert is one statement: it runs only when every count is still under its limit. The 7441 binding caps bursts at 4 per minute and is keyed by the /64, so an IPv6 host cannot rotate the lower bits to slip past it. Reads are 7442 (120 per minute). Session acquires are 7443 (40 per minute per browser), checked in the workflow step. The whole demo stops at 300 captures per 24 hours with `daily budget used up`.
- Reuse walks `puppeteer.sessions()` from the newest `startTime`. The first session whose `Target.getBrowserContexts` count is under 3 is disconnected and left warm (`keep_alive` is 5 minutes). A count that cannot be read is skipped. When every listed session is full, the step launches a browser with `keep_alive` of 10 seconds and `disconnect()`s it. It never `close()`s a browser, because another step may be connected to it. There is no inflight counter.
- Pages must be `http` or `https` on port 80 or 443. Loopback, private, link-local, CGNAT, metadata, and SIIT (`::ffff:0:0:0/96`) ranges are blocked for IPv4 and IPv6, including decimal, hex, and IPv4-mapped spellings. Internal names include `.local`, `.lan`, `.intranet`, `.corp`, and `.arpa` (which includes `.home.arpa`). Every main-frame hop, including each redirect and the final URL, calls `authorizeNavigation` with a fresh DNS lookup. That result is not cached. Subresources and subframes run the scheme and port check on every request and cache only the DNS answer per hostname, so `http://host:8080/` is blocked even after `https://host/` was allowed. A and AAAA queries run in parallel. Distinct subresource hosts are capped at 64; a further host is aborted with no lookup, and the capture continues. A finished response from a blocked IP fails the capture. An aborted subresource does not.
- Downloads and non-document navigations are blocked. Before the page goes offline, the viewport grows to the capture height and the network is allowed to go idle again, with the guards still active. Then the page is set offline, so a late iframe cannot land in the screenshot. Navigation waits 12 seconds. The HTML `Content-Length` is capped at 1.5 MB. The in-page `outerHTML` length is capped at 1.5 million characters. Screenshots are capped at 4096px tall and 6 MB, and fall back to JPEG if the PNG is over that. PDFs are the first 20 pages and capped at 8 MB. Markdown is truncated in the page. The page step timeout is 120 seconds, which covers those waits.
- Turnstile is required before a capture starts, and a production token must report action `capture`. A missing secret fails closed. A capture and its files are readable only by the browser that created them. The gallery lists this browser's captures, not anyone else's.
- Workers AI writes a summary of untrusted page content. If the model is unavailable, the page shows an excerpt and says so.
- A cron every 15 minutes deletes capture rows whose `expires_at` has passed (24 hours after creation) and the R2 objects under that id. A row can therefore live a little longer than 24 hours. An R2 lifecycle rule on `captures/` is the backstop if the cron misses a delete. Lifecycle expiry is in days, so it is not the 24-hour clock.

### Residual risk

The page script replaces `WebSocket`, `WebTransport`, `RTCPeerConnection`, `SharedWorker`, `Worker`, `serviceWorker.register`, and `window.open`. A new page target in this browser context is closed after `newPage()` resolves, so the capture's own page is not closed and other captures' contexts are not seen. `@cloudflare/puppeteer` 1.4.0 does not add dedicated-worker sessions to the page network manager, so interception, response-IP checks, and the seal do not see worker traffic. On `workercreated` the worker is set offline. If that CDP call fails, the capture fails. A worker can still send a request in the gap before `Network.emulateNetworkConditions` lands, and a constructor the page already captured can stay reachable. A connection Chrome opens itself, or a response that never reports a remote IP, is not a failure. DoH and Chrome can also disagree for a moment. A finished response from a blocked IP fails the capture.

## What is real

- Browser Rendering on the Workers Paid plan. `@cloudflare/puppeteer` launches Chrome, reuses the newest session under the context cap, and `disconnect()`s every browser it opened.
- The Workflow reads the URL from D1. One step loads the page and stores the desktop screenshot, the PDF, and the markdown. A second step stores the phone screenshot.
- D1 stores the capture row, the HMAC of the /64 and of the /48, and which files exist. R2 stores `desktop.png` (or `desktop.jpg`), `phone.png` (or `phone.jpg`), `page.pdf`, `page.md`, and `summary.txt` under `captures/<id>/`.
- With `ENVIRONMENT=local` the same steps run, but the bytes are a stand-in. Browser Rendering does not run without a Cloudflare login.

## Run locally

```bash
cd demos/edge-browser
cp .dev.vars.example .dev.vars
bun install
bun run dev:local
```

`.dev.vars` uses Cloudflare's [always-pass Turnstile test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/). `ENVIRONMENT=local` is required because `wrangler dev` rewrites Host to the first production route, and it is also what selects the stand-in. The widget token for those keys is `XXXX.DUMMY.TOKEN.XXXX`.

`bun run dev:local` listens on `http://127.0.0.1:8791`. `bun run smoke` expects that URL. It checks Turnstile rejection, SSRF rejection, and the stand-in flow.

`bun run dev` uses `wrangler.jsonc`, which includes the browser binding and Workers AI. Both need a logged-in Wrangler session. Browser Rendering is not available in fully local mode. Leave `ENVIRONMENT=local` in `.dev.vars` to keep the stand-in, or remove it only when you are logged in and want a real Chrome. Do not deploy from this PR.

`bun run typecheck` runs `wrangler types` before `tsc`, so a clean clone does not need a committed `worker-configuration.d.ts`.

## Deploy

Do not deploy from this PR until the resources below exist. From this folder, with the owner account (unset any other API token):

```bash
bunx wrangler d1 create tech-demos-edge-browser
# paste the database_id over the placeholder in wrangler.jsonc
bunx wrangler r2 bucket create tech-demos-edge-browser
bunx wrangler r2 bucket lifecycle add tech-demos-edge-browser captures-expiry captures/ --expire-days 1
# TURNSTILE_SITE_KEY is already the live widget key in wrangler.jsonc.
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler deploy
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler secret put TURNSTILE_SECRET
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler secret put IP_HASH_SECRET
```

A brand-new Worker with `secrets.required` needs a first deploy before `wrangler secret put` works, or a secrets file. The first deploy command above is that deploy. Run both `secret put` commands after it, then deploy once more so the secrets are visible to new instances. `IP_HASH_SECRET` is the HMAC key for the stored network ids.

### Resources to create

| Resource | Name | Status |
| --- | --- | --- |
| D1 database | `tech-demos-edge-browser` | **Create.** `wrangler d1 create tech-demos-edge-browser`, then paste `database_id` over `00000000-0000-4000-8000-000000007441` in `wrangler.jsonc`. |
| R2 bucket | `tech-demos-edge-browser` | **Create.** `wrangler r2 bucket create tech-demos-edge-browser`, then `wrangler r2 bucket lifecycle add tech-demos-edge-browser captures-expiry captures/ --expire-days 1`. That rule is the backstop. It is not a `wrangler.jsonc` field. |
| Turnstile widget | shared `tech-demos-shared` | **Reuse it.** Do not create a widget. `TURNSTILE_SITE_KEY` is `0x4AAAAAAFRUoj5qDpf7XyIW`. The secret is `wrangler secret put TURNSTILE_SECRET` after the first deploy. Do not commit it. See `docs/turnstile.md`. |
| Browser Rendering | binding `BROWSER` | No separate namespace. The binding is in `wrangler.jsonc`. The account needs Browser Rendering on Workers Paid. |
| Workflow | `tech-demos-edge-browser-capture` | Created on deploy from the `CAPTURE` binding. |
| Rate-limit namespaces | `7441` capture, `7442` read, `7443` session | Created when this Worker is deployed. They do not overlap the ids already in the repo. `7443` is checked in the workflow step. There is no Durable Object. |
| Cron | `*/15 * * * *` | Applied on deploy. Deletes rows with `expires_at` in the past (24 hours after creation) and their R2 objects. A file can outlive that by one cron interval. |
| Routes | `tech-demos.theserverless.dev/demos/edge-browser*` and `edge-browser.tech-demos.theserverless.dev/*` | Applied on deploy. The zone is `theserverless.dev`. |

Production fails closed when `TURNSTILE_SECRET` is missing, and it rejects the always-pass test secret unless `ENVIRONMENT` is `local`.

After the Worker is deployed, redeploy `apps/hub` so the gallery card is not only the fallback. That fallback redirects `tech-demos.theserverless.dev/demos/edge-browser` to `https://edge-browser.tech-demos.theserverless.dev`.

## Layout

```
src/worker/   API, CaptureWorkflow, puppeteer, SSRF, Turnstile
src/client/   progress, gallery, previews
public/       Graphite & Ember page
migrations/   captures
test/         SSRF guard and escaped markdown
```
