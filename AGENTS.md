# AGENTS.md — tech-demos

## Purpose

Sticky playground for one new tech demo at a time. Cloud agents and Grok Bot Tech Demos collaborate here.

## Constraints

- Owner is on **Workers Paid (~$5/mo)** only.
- **Do not** use Workers for Platforms / dispatch namespaces.
- Prefer **Workers + Static Assets**, **Dynamic Workers** (Worker Loader), D1, KV, R2, Durable Objects (SQLite), Queues, Workflows, Workers AI, Vectorize, Agents SDK — all available on Paid with usage billing.
- Avoid Containers / Browser Run / heavy extras unless the demo truly needs them and the owner approves cost.
- Runtime: **Bun**. Include root `bunfig.toml` with `minimumReleaseAge = 259200` before installs.
- Model for initial prototypes: **claude-fable-5 (Fable 5)** unless the owner asks otherwise.
- Never create a new GitHub repo per demo. Only add/update under this repo.
- Every PR must include **at least one screenshot AND one video** of the running demo.

## Layout

```
apps/hub/           # gallery + Dynamic Worker Loader
demos/<slug>/       # one demo per folder
packages/shared/    # shared types/utils
tracking/seen.json  # scout tracking
skills/project-planning/
```

## Cloud agent rules

1. Read `skills/project-planning/SKILL.md` and write `demos/<slug>/PLAN.md` before coding.
2. Only touch `demos/<slug>/` plus the hub registry entry in `apps/hub/src/registry.ts` (and shared types if needed).
3. Demo must run with `bun install && bun run --filter @tech-demos/hub dev` (or the demo’s own `wrangler dev` if standalone).
4. Open **one** PR. Attach screenshot + video validation artifacts.
5. Do not post to X unless explicitly asked (demo account, not personal).
