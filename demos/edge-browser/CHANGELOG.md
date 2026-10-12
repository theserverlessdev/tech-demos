# Changelog

This demo is an inspired-by slice of [cloudflare/puppeteer](https://github.com/cloudflare/puppeteer), Cloudflare's Puppeteer fork for Browser Rendering. It is not a fork and it does not vendor that codebase.

## Different from the Puppeteer examples

- One anonymous capture, started only after Turnstile. No shared API token in the browser.
- A Workflow runs the desktop screenshot, the 390px phone screenshot, the PDF, the markdown extraction, and the Workers AI summary as separate steps.
- There is no Durable Object. Reuse walks `puppeteer.sessions()` from the newest `startTime`, then `connect()`, then `Target.getBrowserContexts`. A full session launches a browser with a 10 second `keep_alive`. Every browser is `disconnect()`ed.
- Files go to R2 under an unguessable id. D1 stores status for this browser's gallery. A 15-minute cron deletes both after 24 hours.
- The URL is checked before navigation: scheme, port, internal hostnames, and blocked IPv4 and IPv6 ranges, including decimal, hex, and IPv4-mapped forms. DNS-over-HTTPS runs before navigation and again on redirects and the final URL.
- Rate limits are capture `7441`, read `7442`, and session `7443`.
- Graphite & Ember UI. No React.

## Same idea

`@cloudflare/puppeteer` drives a headless Chrome through the Browser Rendering binding, including session reuse.

## 2026-10-12

First slice: capture form, live steps, gallery, screenshot frames, PDF, escaped markdown, summary, and the deletion notice. Phone layout uses 16px fields, 44px controls, and a screenshot frame that scrolls on its own.

Security pass: reuse comes from `puppeteer.sessions()` and `Target.getBrowserContexts`, with no inflight counter. Subresource hosts are DNS-checked, the page goes offline before the files are written, and a finished private-IP response fails the capture. Spend limits are per browser, per IPv4 or IPv6 /64, and 300 a day. Files require the same visitor. Desktop, PDF, and markdown share one page load.

Follow-up: popup targets are closed on the page's own browser context after `newPage()` resolves. Dedicated workers are neutered and set offline. Subresource DNS is cached per host, while scheme and port are checked on every request. Overflow browsers use a 10 second `keep_alive` and are disconnected. The network id is an HMAC with `IP_HASH_SECRET`, with a /48 cap of 20 per hour, enforced by a single conditional insert. The BrowserSession Durable Object is gone.
