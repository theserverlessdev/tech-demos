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
- An expiry path that deletes the visitor's data

## Branding

Hub Graphite & Ember. Ember accent `#c2410c`, background `#0e0e11`. Contact links to <https://theserverless.dev/contact>. The mark links back to the hub.

## 2026-10-09

Phone layout: 16px fields, 44px controls, sticky composer, and safe-area padding. Graphite and Ember colours are unchanged.
