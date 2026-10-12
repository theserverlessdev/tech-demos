# Edge browser

Live at [tech-demos.theserverless.dev/demos/edge-browser](https://tech-demos.theserverless.dev/demos/edge-browser/) after deploy.

Paste a public URL. A Workflow drives headless Chrome and stores a desktop screenshot, a 390px phone screenshot, a PDF, markdown, and a short summary.

Inspired by [cloudflare/puppeteer](https://github.com/cloudflare/puppeteer), Cloudflare's Puppeteer fork for [Browser Rendering](https://developers.cloudflare.com/browser-run/). This demo calls that library from a Worker. It does not vendor the repo.

## What this demonstrates

**Pattern.** A Worker on the Workers Paid plan drives headless Chrome through the Browser Rendering binding and `@cloudflare/puppeteer`. A Workflow takes a desktop screenshot, a 390px phone screenshot, a PDF, and markdown, then Workers AI summarizes it. A Durable Object keeps one warm browser session (`puppeteer.sessions`, `puppeteer.connect`, `puppeteer.launch({ keep_alive })`) and launches a fresh browser when that session is missing or over its limits. There are no Containers and no Workers for Platforms.

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

- Six captures per browser per hour, and six per network per hour. The network key is the IPv4 address or the IPv6 /64, stored only as a hash. The 7441 binding caps bursts at 4 per minute and is keyed the same way, so an IPv6 /64 cannot rotate the host bits to slip past it. Reads are 7442 (120 per minute). Session acquires are 7443 (40 per minute per browser). The whole demo stops at 300 captures per 24 hours with `daily budget used up`.
- Reuse asks `puppeteer.sessions()`, then `connect()`, then `Target.getBrowserContexts`. Under 3 contexts the step disconnects and leaves the session warm (`keep_alive` is 5 minutes). At the cap, or when the count cannot be read, the step launches a browser and `close()`s it. There is no inflight counter to leak.
- Pages must be `http` or `https` on port 80 or 443. Loopback, private, link-local, CGNAT, metadata, and SIIT (`::ffff:0:0:0/96`) ranges are blocked for IPv4 and IPv6, including decimal, hex, and IPv4-mapped spellings. Internal names include `.local`, `.home.arpa`, `.lan`, `.intranet`, `.corp`, and `.arpa`. DNS is resolved with Cloudflare DoH before navigation, again for each redirect and the final URL, and once per subresource or subframe host. A finished response from a blocked IP fails the capture. An aborted subresource does not.
- Downloads and non-document navigations are blocked. After the network goes idle the page is set offline, so a late iframe cannot land in the screenshot. Navigation waits 12 seconds. HTML is measured in the page and capped at 1.5 MB. Screenshots are capped at 4096px tall and 6 MB, and fall back to JPEG if the PNG is over that. PDFs are the first 20 pages and capped at 8 MB. Markdown is truncated in the page.
- Turnstile is required before a capture starts, and a production token must report action `capture`. A missing secret fails closed. A capture and its files are readable only by the browser that created them. The gallery lists this browser's captures, not anyone else's.
- Workers AI writes a summary of untrusted page content. If the model is unavailable, the page shows an excerpt and says so.
- A cron every 15 minutes deletes capture rows whose `expires_at` has passed (24 hours after creation) and the R2 objects under that id. A row can therefore live a little longer than 24 hours. An R2 lifecycle rule on `captures/` is the backstop if the cron misses a delete. Lifecycle expiry is in days, so it is not the 24-hour clock.

### Residual risk

The page script replaces `WebSocket`, `WebTransport`, `RTCPeerConnection`, `SharedWorker`, `serviceWorker.register`, and `window.open`, and a new page target is closed. That does not cover a connection Chrome opens itself, a constructor the page already captured, or a response that never reports a remote IP. DoH and Chrome can also disagree for a moment. A finished response from a blocked IP fails the capture. A request that never reports an IP does not.

## What is real

- Browser Rendering on the Workers Paid plan. `@cloudflare/puppeteer` launches Chrome, reuses a session when `Target.getBrowserContexts` is under the cap, and `close()`s a one-off browser otherwise.
- The Workflow reads the URL from D1. One step loads the page and stores the desktop screenshot, the PDF, and the markdown. A second step stores the phone screenshot.
- D1 stores the capture row, the hashed network key, and which files exist. R2 stores `desktop.png` (or `desktop.jpg`), `phone.png` (or `phone.jpg`), `page.pdf`, `page.md`, and `summary.txt` under `captures/<id>/`.
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
# This Wrangler version has no lifecycle field in wrangler.jsonc. In the R2 dashboard,
# add a rule on tech-demos-edge-browser: prefix captures/, delete objects after 2 days.
# create the Turnstile widget, put its site key in TURNSTILE_SITE_KEY, then:
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler deploy
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler secret put TURNSTILE_SECRET
```

A brand-new Worker with `secrets.required` needs a first deploy before `wrangler secret put` works, or a secrets file. The first deploy command above is that deploy. Run `secret put` after it, then deploy once more so the secret is visible to new instances.

### Resources to create

| Resource | Name | Status |
| --- | --- | --- |
| D1 database | `tech-demos-edge-browser` | **Create.** `wrangler d1 create tech-demos-edge-browser`, then paste `database_id` over `00000000-0000-4000-8000-000000007441` in `wrangler.jsonc`. |
| R2 bucket | `tech-demos-edge-browser` | **Create.** `wrangler r2 bucket create tech-demos-edge-browser`. Then add a lifecycle rule: prefix `captures/`, delete after 2 days. That rule is the backstop. It is not a `wrangler.jsonc` field. |
| Turnstile widget | `tech-demos-edge-browser` | **Create.** Hostnames: `tech-demos.theserverless.dev`, `edge-browser.tech-demos.theserverless.dev`. Put the site key in `TURNSTILE_SITE_KEY` (it is `REPLACE_ME` until then) and the secret with `wrangler secret put TURNSTILE_SECRET` after the first deploy. |
| Browser Rendering | binding `BROWSER` | No separate namespace. The binding is in `wrangler.jsonc`. The account needs Browser Rendering on Workers Paid. |
| Workflow | `tech-demos-edge-browser-capture` | Created on deploy from the `CAPTURE` binding. |
| Durable Object class | `BrowserSession` | Created by the `v1` migration on deploy. |
| Rate-limit namespaces | `7441` capture, `7442` read, `7443` session | Created when this Worker is deployed. They do not overlap the ids already in the repo. |
| Cron | `*/15 * * * *` | Applied on deploy. Deletes rows with `expires_at` in the past (24 hours after creation) and their R2 objects. A file can outlive that by one cron interval. |
| Routes | `tech-demos.theserverless.dev/demos/edge-browser*` and `edge-browser.tech-demos.theserverless.dev/*` | Applied on deploy. The zone is `theserverless.dev`. |

Production fails closed when `TURNSTILE_SECRET` is missing, and it rejects the always-pass test secret unless `ENVIRONMENT` is `local`.

After the Worker is deployed, redeploy `apps/hub` so the gallery card is not only the fallback redirect.

## Layout

```
src/worker/   API, CaptureWorkflow, BrowserSession, puppeteer, SSRF, Turnstile
src/client/   progress, gallery, previews
public/       Graphite & Ember page
migrations/   captures
test/         SSRF guard and escaped markdown
```
