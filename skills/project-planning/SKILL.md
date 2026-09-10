---
name: Project planning
description: >-
  Use when starting a new project, scoping an idea, choosing a stack, or
  producing an MVP implementation plan — an opinionated Bun/shadcn planning
  skill.
---
Turn a fresh project idea into a focused, MVP-first plan that favors prebuilt solutions and opinionated frameworks over custom complexity.

## Workflow

1. Clarify the goal in one sentence and define the single-user MVP boundary: what ships in the first cut, what is explicitly out of scope.
2. Decompose the goal into a small set of manageable tasks. Group by user-visible outcome, not by layer.
3. Spawn subagents in parallel to research frameworks and libraries that could absorb whole tasks. Prefer pre-built solutions unless a clear constraint rules them out.
4. Prefer Cloudflare Workers primitives available on **Workers Paid**: Dynamic Workers, Static Assets, D1, KV, R2, Durable Objects (SQLite), Queues, Workflows, Workers AI, Vectorize, Agents SDK. Do **not** use Workers for Platforms.
5. Before any dependency install, ensure root `bunfig.toml` has `[install] minimumReleaseAge = 259200`.
6. For UI demos, keep the surface small; shadcn/ui is fine when a real UI is needed.
7. Lay out components and services in a logical structure before any code is written.
8. Decide the minimum useful testing surface (default: small).
9. Produce a short plan: goal, MVP scope, task list, stack choices with one-line rationale, deferred items.
10. Write the plan to `demos/<slug>/PLAN.md`, register the demo in `apps/hub/src/registry.ts`.

## Planning Rules

* Build for one user first.
* Use Bun as the runtime, package manager, and script runner by default.
* Prefer prebuilt over bespoke.
* Choose boring, well-documented defaults. Novelty is a cost, not a feature.
* Cut features before cutting clarity.
* Defer anything not on the path to a working MVP.
* Re-evaluate the plan once the first end-to-end slice runs.
