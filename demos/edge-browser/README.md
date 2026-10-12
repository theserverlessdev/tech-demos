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

- Six captures per browser per hour. The 7441 binding also caps bursts at 4 per minute. Reads are 7442 (120 per minute). Session acquires are 7443 (40 per minute per browser).
- The warm session allows 3 in-flight contexts, 32 browser steps, and 10 minutes of age. `keep_alive` is 5 minutes. Past those limits the next step launches a fresh browser. If connect fails, it launches one too.
- Pages must be `http` or `https` on port 80 or 443. Loopback, private, link-local, CGNAT, and metadata ranges are blocked for IPv4 and IPv6, including decimal, hex, and IPv4-mapped spellings. DNS is resolved with Cloudflare DoH before navigation, and again for each redirect and the final URL. The response IP is checked as well.
- Downloads and non-document navigations are blocked. Navigation waits 12 seconds. HTML is capped at 1.5 MB. Screenshots are capped at 4096px tall and 6 MB. PDFs are capped at 8 MB.
- Turnstile is required before a capture starts. A missing secret fails closed. Outputs are readable only with the unguessable capture id. The gallery lists this browser's captures, not anyone else's.
- Workers AI writes the summary from the markdown. If the model is unavailable, the page shows an excerpt and says so.
- Captures and their R2 objects are deleted 24 hours after they are created. A cron runs every 15 minutes.

## What is real

- Browser Rendering on the Workers Paid plan. `@cloudflare/puppeteer` launches Chrome, reuses a session, and disconnects without closing it so the next capture can connect.
- The Workflow is the durable log of the five outputs. Each browser step acquires the session Durable Object, then connects or launches.
- D1 stores the capture row the gallery and the cron use. R2 stores `desktop.png`, `phone.png`, `page.pdf`, `page.md`, and `summary.txt` under `captures/<id>/`.
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
# create the Turnstile widget, put its site key in TURNSTILE_SITE_KEY, then:
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler deploy
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=3f847e2fadeef3e583701e8fa25657b5 bunx wrangler secret put TURNSTILE_SECRET
```

A brand-new Worker with `secrets.required` needs a first deploy before `wrangler secret put` works, or a secrets file. The first deploy command above is that deploy. Run `secret put` after it, then deploy once more so the secret is visible to new instances.

### Resources to create

| Resource | Name | Status |
| --- | --- | --- |
| D1 database | `tech-demos-edge-browser` | **Create.** `wrangler d1 create tech-demos-edge-browser`, then paste `database_id` over `00000000-0000-4000-8000-000000007441` in `wrangler.jsonc`. |
| R2 bucket | `tech-demos-edge-browser` | **Create.** `wrangler r2 bucket create tech-demos-edge-browser`. |
| Turnstile widget | `tech-demos-edge-browser` | **Create.** Hostnames: `tech-demos.theserverless.dev`, `edge-browser.tech-demos.theserverless.dev`. Put the site key in `TURNSTILE_SITE_KEY` (it is `REPLACE_ME` until then) and the secret with `wrangler secret put TURNSTILE_SECRET` after the first deploy. |
| Browser Rendering | binding `BROWSER` | No separate namespace. The binding is in `wrangler.jsonc`. The account needs Browser Rendering on Workers Paid. |
| Workflow | `tech-demos-edge-browser-capture` | Created on deploy from the `CAPTURE` binding. |
| Durable Object class | `BrowserSession` | Created by the `v1` migration on deploy. |
| Rate-limit namespaces | `7441` capture, `7442` read, `7443` session | Created when this Worker is deployed. They do not overlap the ids already in the repo. |
| Cron | `*/15 * * * *` | Applied on deploy. Deletes captures and R2 objects older than 24 hours. |
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
