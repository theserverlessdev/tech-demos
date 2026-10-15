# Changelog

This demo is an inspired-by slice of [supermemoryai/memoryrepo](https://github.com/supermemoryai/memoryrepo) (MIT). It is not a fork and it does not vendor that codebase. Upstream is an open-source take on Cognition's [agent memory repo](https://cognition.com/agent-memory-repo). The live app is [memoryrepo.dev](https://memoryrepo.dev).

## Different from MemoryRepo

- Anonymous visitor cookie instead of email codes and Cloudflare Email Sending.
- No Alchemy. The Worker, Durable Objects, D1, Artifacts, Turnstile, and rate limits are declared in `wrangler.jsonc`.
- Workers AI (`@cf/zai-org/glm-5.3-flash`) instead of OpenRouter. No model picker and no cost ledger.
- One chat thread per visitor. Two Durable Objects still: `ChatAgent` for the thread and `MemoryAgent` for the repo.
- Recall is SQLite FTS5 over the four memory files, plus `MEMORY.md` in the prompt. No sandboxed bash, no `just-bash`.
- Topic files are flat: `people.md`, `preferences.md`, `projects.md`. No per-person paths, notes editor, or graph view.
- A dream is one Workers AI call that returns the consolidated files. Unusable output commits nothing and the page says why. Upstream dreams with a tool loop.
- Commits go out as Git packs over smart HTTP, the same path as repo-per-agent. The Artifacts binding creates the repo, reads the tree, and mints the write token.
- Turnstile gates repo creation. Rate limits are chat `7431`, dream `7432`, create `7433`, and read `7434`. New ids start at 7490.
- The repo, the FTS index, the chat Durable Object, and the D1 row are deleted 24 hours after the last message.
- Graphite & Ember UI. No React, no Quartz graph, no Pierre diffs.

## Same idea

Long-term memory is a git repository of markdown. `MEMORY.md` is the index. Every memory write is a commit, and so is every dream. The history and the diff are the audit trail.

## 2026-10-14

Audit fixes: expiry now destroys the chat Durable Object; dreams skip when memory moved during the model call; regex facts are fallback-only; chat writes keep `- ` bullets; chips honor in-flight; daily AI caps; `/api/health` is rate-limited and does not call Artifacts; dream `max_tokens` 6000 with changed-files-only JSON; phone composer sits under the Chat heading at 390px.

## 2026-10-09

First slice: chat, memory tree, commit diff, Dream now, and the 24-hour deletion notice. Phone layout uses tabs, 16px fields, 44px controls, and a sticky composer.
