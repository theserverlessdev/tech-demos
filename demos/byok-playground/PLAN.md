# Plan — byok-playground

## Goal

A visitor pastes an OpenAI-compatible API key, base URL, and model id, then streams chat, lists models, runs capability probes, and compares the same prompt against Workers AI — through a Worker that never stores the key and refuses to become an open proxy.

## Single-user MVP

- In:
  - Browser-only key storage (`sessionStorage` by default, opt-in `localStorage`, Clear).
  - Worker proxy for `POST /chat/completions` (SSE passthrough) and `GET /models`, with the key in a request header only.
  - Hard SSRF guard: https only (http://localhost under wrangler dev), no redirects, IP/hostname denylist, path allowlist, size/time/concurrency caps, hop-by-hop and cookie stripping.
  - Same-origin + session cookie on every proxy call.
  - Per-IP rate limits on namespaces 7461–7463.
  - Side-by-side compare vs Workers AI, Turnstile-gated, atomic D1 daily budget with HMAC’d `ip_key`.
  - Capability checks: streaming, tools, JSON schema, vision.
  - Graphite & Ember UI, Contact CTA, hub registry card, tests, README, CHANGELOG.
- Out: accounts, key vaults, billing, Workers for Platforms, Containers, Browser Run, storing keys, arbitrary URL proxying.

## Tasks

1. SSRF, header allowlists, redaction, session cookie, origin check.
2. Proxy: chat SSE, list models, size/time/concurrency caps.
3. Compare path: Turnstile, D1 budget, Workers AI (stub when the binding is missing).
4. Capability probes with pass / fail / unsupported and the raw error.
5. Graphite & Ember UI, 390px layout, text-only model output.
6. Tests, mock OpenAI server, typecheck, screenshots, video, one PR. Do not deploy.

## Stack

- **Workers + Static Assets** — same standalone shape as memory-repo (hub path + subdomain).
- **D1** — atomic daily compare budget only. No chat history.
- **Workers AI** — the “ours” side of compare. Local wrangler config omits the binding and uses a labelled stub.
- **Turnstile + rate limits 7461–7463** — compare is gated; every proxy route is limited per IP.
- **No Hono, no React.** Vanilla TS + Graphite & Ember CSS.

## Architecture

```mermaid
flowchart TD
  browser[Browser sessionStorage]
  worker[Worker tech-demos-byok-playground]
  ssrf[SSRF + path allowlist]
  userApi[Visitor OpenAI-compatible API]
  ai[Workers AI]
  d1[D1 daily budget]
  turnstile[Turnstile siteverify]

  browser -->|key in x-byok-key header| worker
  worker --> ssrf
  ssrf -->|/chat/completions /models| userApi
  browser -->|Turnstile token| worker
  worker --> turnstile
  worker --> d1
  worker --> ai
```

Worker `tech-demos-byok-playground`:

- `tech-demos.theserverless.dev/demos/byok-playground*`
- `byok-playground.tech-demos.theserverless.dev/*`

## Cost

- Compare calls Workers AI with a small `max_tokens` cap.
- Global D1 daily cap plus per-`ip_key` cap.
- Visitor chat is billed to their key, not ours.
- No Durable Objects, R2, Queues, Containers, or Browser Rendering.

## Testing

- Unit tests: SSRF bypass cases, header stripping, key never in logs or errors.
- `bun test` and `tsc`.
- Local mock OpenAI server + Workers AI stub for screenshots and a short video.

## Deferred

- DNS pinning for the full fetch (DoH is checked before fetch; TOCTOU remains).
- A shared `@tech-demos/guardrails` package.
- Provider-specific auth schemes beyond `Authorization: Bearer`.
