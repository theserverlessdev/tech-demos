# Changelog — personal-agent vs workers-personal-agent

This demo is a slice of [DomWane/workers-personal-agent](https://github.com/DomWane/workers-personal-agent) by DomWane (MIT), not a drop-in fork. Upstream is a personal agent with a Vue client, several Durable Objects, and optional third-party model and search keys. This repo is a **hosted demo** of the memory and research idea on Workers Paid, without Workers for Platforms.

The X post that pointed at the upstream repo: <https://x.com/tonycasavan/status/2101803028315537806>.

## Architecture

| | workers-personal-agent (upstream) | This demo |
| --- | --- | --- |
| Runtime | Workers, Agents SDK, Vue 3, Vite, Tailwind | One Worker, plain `fetch()` router, vanilla TS UI |
| Conversation | WebSocket, `setState` broadcast, several threads | HTTP JSON. One Durable Object per anonymous visitor. Thread in DO SQLite. |
| Memory | R2 vault: memories, profile, skills. Embedding index in its own Durable Object. | R2 markdown notes under `v/<visitorId>/`. Vectors in the same Durable Object. Cosine in process, keyword overlap when embeddings fail. |
| Model | Workers AI via `CF_API_TOKEN`, or any OpenAI-compatible endpoint | Workers AI binding only. No `CF_API_TOKEN`, no `LLM_API_KEY`. Chat fails soft to an excerpt. |
| Research | Plan card, child scout Durable Objects, Tavily, Firecrawl, Browser Rendering | 2–4 `fetch`es. Host allowlist, 180 KB cap, 8s timeout, manual redirects, no private IPs. Workers AI summary with URL citations. |
| Access | Cloudflare Access in front of the Worker | Turnstile on chat, research, and note writes. Fail closed without `TURNSTILE_SECRET`. |
| Limits | Subrequest counter, free-plan neuron budget | `CHAT_LIMIT`, `RESEARCH_LIMIT`, `READ_LIMIT`. 40 notes, 40 messages, 24h alarm expiry. |
| Extra | Skills, reminders, MCP, history compaction, nightly reflection, eval harness | Cut |

## What we cut

- Vue, Tailwind, shadcn-vue, and the WebSocket client
- Cloudflare Access and `ALLOW_UNPROTECTED`
- `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `LLM_API_KEY`, `TAVILY_API_KEY`, `FIRECRAWL_API_KEY`
- Scout Durable Objects and the research plan card
- MCP servers and OAuth
- Skills, reminders, history compaction, nightly reflection
- A separate embedding-index Durable Object
- Browser Rendering
- Workers for Platforms / dispatch namespaces

## What we kept (simplified)

- One Durable Object holding the conversation
- Markdown notes in R2 and vector recall beside each reply
- A research fan-out that cites URLs
- An expiry path that deletes the visitor's R2 prefix and `destroy()`s the Durable Object

## Branding

Hub Graphite & Ember. Ember accent `#c2410c`, background `#0e0e11`. Contact links to <https://theserverless.dev/contact>. The mark links back to the hub.

## 2026-10-15

Audit fixes for the docs catalog, Durable Object lifetime, recall floor, and phone layout. Review follow-ups close the leftover Durable Object leak and the 390 px gate.

- Research asks Cloudflare docs for markdown, truncates at 180 KB instead of failing, and keeps a single catalog match (padded with defaults). Citation titles come from YAML `title:` or the first `#` heading; docs boilerplate is stripped from excerpts. The UI placeholder question is a smoke check.
- Page views, unsigned GETs, and expired tokens do not call `getAgentByName`. The first Turnstile-gated write mints an HMAC-signed `id.exp.sig` token sent as `x-visitor-token`. Writes re-sign the token. `onStart` arms `purgeExpired` when no purge is scheduled. Chat and note bodies are validated in the Worker before the Durable Object is named.
- GLM-5.3 Flash uses `reasoning_effort: "low"` and `max_completion_tokens: 1500`. Recall needs cosine ≥ 0.58 or two keyword hits. Local screenshots show the fallback path; a live paid Workers AI call was not run and would not by itself prove those settings.
- Phone: static topbar, per-panel status, a wrapping Turnstile gate that sticks at the bottom, scrollable thread after chat only, and `overflow-wrap: anywhere` on long URLs.

## 2026-10-09

Phone layout: 16px fields, 44px controls, sticky composer, and safe-area padding. Graphite and Ember colours are unchanged.
