# Edge browser

## Goal

Prove that a Worker on the Workers Paid plan can drive a real headless Chrome at the edge, through Browser Rendering and `@cloudflare/puppeteer`, and turn one public URL into a desktop screenshot, a phone screenshot, a PDF, markdown, and a short Workers AI summary.

## MVP

One anonymous visitor pastes an `http` or `https` URL, passes Turnstile, and watches a Workflow write those five outputs. Files live in R2 under an unguessable capture id. D1 stores status and history for that browser. One Durable Object remembers a warm browser session and launches a fresh browser when that session is missing or over its limits. A cron deletes captures and objects after 24 hours.

## Out of scope

Containers, Workers for Platforms, authenticated sites, logins, multi-page crawls, and keeping captures longer than a day.

## Stack

- Workers + Static Assets, because the page and the API share one Worker.
- Browser Rendering binding + `@cloudflare/puppeteer` (Cloudflare's Puppeteer fork), because that is the headless Chrome on the Paid plan.
- Workflows, because each output is a durable step that can retry without repeating the whole capture.
- A SQLite Durable Object, because the warm `sessionId` has to survive across those steps with a single writer for the limits.
- R2 and D1, because the bytes and the status are different lifetimes.
- Workers AI, because the summary should be a short model pass over the markdown, with an excerpt when the model is unavailable.
- Turnstile and three rate-limit bindings (7441 capture, 7442 read, 7443 session), matching the sibling demos.

## Tasks

1. SSRF guard with DoH, redirect re-checks, and unit tests for decimal, hex, mapped IPv6, and DNS rebinding.
2. Browser session Durable Object: `puppeteer.sessions`, `puppeteer.connect`, `puppeteer.launch({ keep_alive })`, and a fresh browser when nothing qualifies.
3. Capture Workflow, R2 prefix, D1 history, 24-hour cron.
4. Graphite & Ember page: progress, gallery, previews, escaped markdown.
5. Hub registry fallback and the README resources list.

## Deferred

Remote Browser Rendering against a logged-in account. Local dev uses a stand-in when `ENVIRONMENT=local`, because Browser Rendering does not run without Cloudflare login.
