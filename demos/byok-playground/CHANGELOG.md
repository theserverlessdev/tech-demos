# Changelog — BYOK playground

A new demo. There is no upstream product; the slice is a safe BYOK proxy pattern on Workers Paid.

## Security model

- The API key lives in the browser. `sessionStorage` is the default. Remember writes `localStorage`. Clear wipes both.
- The Worker sees the key only in `x-byok-key` for that request. It is not stored, not logged, and stripped from error bodies.
- Proxy calls require same-origin plus a session cookie minted on the page. Visitor cookies are never forwarded upstream.
- https only. `http://localhost` / `127.0.0.1` / `::1` only under wrangler dev.
- Redirects are not followed (`redirect: "manual"`, then reject).
- Paths: only `/chat/completions` and `/models` under the pasted base.
- Hop-by-hop headers, cookies, and `X-Forwarded-*` are stripped. Outbound headers are an allowlist.
- Request / response size caps, timeouts, and a per-isolate concurrent stream cap.
- Rate limits `7461`–`7463` per IP on chat, models, and compare.
- Compare is Turnstile-gated and spends an atomic D1 daily budget keyed by HMAC(`ip_key`).
- CSP with no inline script. Model output is `textContent` only.

## UI

Graphite & Ember. Contact links to theserverless.dev. Phone layout at 390px: 16px inputs, 44px tap targets, stacked compare columns, no sideways scroll.

## 2026-10-14

Initial playground: streaming chat, list models, side-by-side Workers AI compare, capability probes, tests, mock OpenAI server.
