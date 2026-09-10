# tech-demos

Sticky monorepo for weekday tech demos on **Cloudflare Workers Paid** ($5).

## Architecture (Paid-plan friendly)

- **No Workers for Platforms** — dispatch namespaces are not on this plan.
- **`apps/hub`** — gallery Worker with a **Dynamic Worker Loader** (`LOADER`). It serves the index UI and loads each demo as an isolated Dynamic Worker at request time.
- **`demos/<slug>`** — self-contained demo source (`worker.ts` + optional assets). New demos land here via PR.
- **`tracking/seen.json`** — scout dedupe (proposed / built / skipped).
- **Workers Builds** — connect `apps/hub` to this repo; push/merge to `main` deploys the hub (demos ship as source the hub loads).

## Commands

```bash
bun install
bun run dev      # hub at http://127.0.0.1:8787
bun run deploy   # wrangler deploy hub
```

## Adding a demo

1. Copy `demos/_template` → `demos/<kebab-slug>`
2. Implement `worker.ts`
3. Register the slug in `apps/hub/src/registry.ts`
4. Open a PR (screenshot + video of the running demo)

## Scout interests

Cloudflare, AI, agents, RAG, distributed systems, self-hosting.
