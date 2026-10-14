# Changelog — BYOK playground

A new demo. There is no upstream product; the slice is a constrained BYOK proxy pattern on Workers Paid.

## Security model

- The API key lives in the browser. `sessionStorage` is the default. Remember writes `localStorage`. Clear wipes both.
- The Worker sees the key only in the JSON body of that request. It is not stored. Invocation logs are disabled; a live dashboard check is still required before claiming the key is never logged. Error bodies strip the exact key; generic Bearer / `sk-` patterns apply to error text and logs only.
- Proxy calls require same-origin plus an HMAC-signed session cookie (issued-at + network key, 12h, rejected on network change) minted after one Turnstile pass when a site key is set. `REPLACE_ME` / `ai: off` disables compare only. Visitor cookies are never forwarded upstream.
- https on port 443. `http://localhost` / `127.0.0.1` / `::1` only when `ENVIRONMENT=local`.
- Redirects are not followed (`redirect: "manual"`, then reject and cancel the body).
- Paths: only `/chat/completions` and `/models` under the pasted base. Not a general-purpose proxy. Rate-limited by network key (`IPv4 /32`, `IPv6 /64`).
- Hop-by-hop headers, cookies, and `X-Forwarded-*` are stripped. Outbound headers are an allowlist. API responses force `application/json` or `text/event-stream` and set `Content-Security-Policy: default-src 'none'; sandbox`.
- Request / response byte caps (including `content-length` and cancelling readers), connect/header timeout, 30s idle between chunks, 120s overall. SSE errors emit `event: error` on a fresh line. Streams are rate-limited per network; there is no per-isolate concurrency lock.
- DNS to the visitor URL is best-effort against rebinding; `global_fetch_strictly_public` is the platform egress backstop.
- Rate limits `7461`–`7463` on chat, models, and compare.
- Compare validates the target before Turnstile. Turnstile action must be `compare`. Atomic D1 daily budget keyed by HMAC(`ip_key`).
- Traces are off so `url.full` cannot carry keys.
- CSP on HTML with no inline script. Model output is `textContent` only.

## UI

Graphite & Ember. Contact links to theserverless.dev. Phone layout at 390px: 16px inputs, 44px tap targets (including footer and brand), key panel in the first screen, top bar on a two-row grid so it does not wrap awkwardly.

## 2026-10-14

Review pass 2: SSE redaction as complete events (no holdback stall), drop isolate stream limiter, body timeouts, session iat+networkKey, printable-ASCII keys, stricter capability evidence, exact-key success redaction.

Review pass: key in JSON body, invocation logs off, signed session, byte caps, SSE error frames, multi-turn history, evidence-based capability passes, subdomain-only origin, copy fixes.

Initial playground: streaming chat, list models, side-by-side Workers AI compare, capability probes, tests, mock OpenAI server.
