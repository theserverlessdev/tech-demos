# Memory repo — plan

## Goal

Show one anonymous visitor that an agent's long-term memory can be plain markdown in a real git repo: every remembered fact is a commit, and every dream is a consolidation commit whose diff explains the change.

## MVP

- Turnstile, then one Artifacts repo per browser cookie.
- ChatAgent (one Durable Object per thread) recalls FTS hits and `MEMORY.md`, replies with Workers AI, and asks MemoryAgent to commit new facts.
- MemoryAgent (one SQLite Durable Object per visitor) owns the repo, the FTS5 index, and a 4-hour dream alarm.
- Dream now, or the alarm, asks Workers AI for consolidated files. Unusable output commits nothing and says why.
- UI: chat, memory tree plus rendered files, commit log and unified diff. Phone layout is tabs.
- A cron and a Durable Object alarm delete the repo and rows 24 hours after the last activity.

## Out of scope

Alchemy, email login, notes editor, graph view, cost ledger, OpenRouter, isomorphic-git, nested per-person files, and a multi-thread inbox. No Workers for Platforms, dispatch namespaces, or Containers.

## Stack

- Workers + Static Assets and the Agents SDK, because that is the sibling pattern for a Durable Object per tenant.
- Artifacts plus Git smart HTTP, copied from the repo-per-agent approach, because the binding reads trees and mints tokens and the commit itself is a pack push.
- D1 for the visitor row the cron sweeps. FTS5 lives in the MemoryAgent SQLite database.
- Workers AI (`@cf/zai-org/glm-5.3-flash`) for chat and dreams. Turnstile and four rate-limit namespaces (7431–7434) gate the public routes.

## Tasks

1. Pure memory-write, dream-parse, and FTS helpers, with unit tests.
2. MemoryAgent and ChatAgent, plus the worker routes.
3. Graphite & Ember page: three panes, tabs on a phone, sticky composer.
4. Hub registry, README, CHANGELOG, `tracking/seen.json`.

## Deferred

Multiple memory banks, a notes editor, and clone tokens. One thread per visitor is enough to show the two-object split.
