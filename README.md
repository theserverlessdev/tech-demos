# tech-demos

Sticky monorepo for weekday tech demos on **Cloudflare Workers Paid** ($5).

## Architecture (Paid-plan friendly)

- **No Workers for Platforms** — dispatch namespaces are not on this plan.
- **`apps/hub`** — gallery Worker with a **Dynamic Worker Loader** (`LOADER`). It serves the index UI and, for loader demos, compiles the demo module at request time.
- **`demos/<slug>`** — self-contained demo source. New demos land here via PR.
- **`tracking/seen.json`** — scout dedupe (proposed / built / skipped).
- **Workers Builds** — connect `apps/hub` to this repo; push/merge to `main` deploys the hub.

There are two kinds of demo. The registry marks each as `kind: "loader"` or `kind: "standalone"`.

### Loader demo (plain JS)

A single `worker.js` with no bindings. The hub imports that file as a **Text** module and `LOADER.get()`s it. `hello-dynamic` is the example.

The loader id is a hash of the source plus the compatibility date, so a source change is a new Dynamic Worker. Cookie and Authorization headers are stripped before the request is forwarded. Every Dynamic Worker response is wrapped with `Content-Security-Policy: sandbox …` and `X-Content-Type-Options: nosniff`.

### Standalone demo (own Worker)

A demo with Durable Objects, D1, R2, or any other binding ships as its **own** Worker. Its `wrangler.jsonc` must declare **both** routes:

- `tech-demos.theserverless.dev/demos/<slug>*`
- `<slug>.tech-demos.theserverless.dev/*`

and register a **fallback** in `apps/hub/src/registry.ts` via `redirectSource(slug, origin)`. The fallback only runs if the zone route is missing. If the hub instead receives the request on the demo subdomain, it returns `503 demo Worker not deployed` rather than redirecting to itself.

**Zone routes win over the custom domain.** The hub's `tech-demos.theserverless.dev` custom domain never sees `/demos/<slug>*` while the standalone Worker's zone route is in place.

## Commands

```bash
bun install
bun run dev      # hub at http://127.0.0.1:8787
bun test         # hub + shared + demo helpers (hello-dynamic is a second bun test run)
bun run deploy   # wrangler deploy hub (owner only)
```

## Adding a demo

### Path A — loader demo (plain JS)

1. Copy `demos/hello-dynamic` → `demos/<kebab-slug>`
2. Implement a single `worker.js` (no TypeScript, no bindings)
3. Register it in `apps/hub/src/registry.ts` with `kind: "loader"` and `import source from "…/worker.js" with { type: "text" }`
4. Open a PR (screenshot + video of the running demo)

### Path B — standalone demo (own Worker)

1. Copy `demos/_template` → `demos/<kebab-slug>` (or an existing standalone demo)
2. Add `wrangler.jsonc` with **both** routes: `/demos/<slug>*` and `<slug>.tech-demos.theserverless.dev/*`
3. Register a `redirectSource(slug, origin)` fallback in `apps/hub/src/registry.ts` with `kind: "standalone"`
4. Open a PR (screenshot + video of the running demo)

Remember: zone routes win over the hub custom domain. Do not expect the hub loader to serve a standalone demo while those routes exist.

## Scout interests

Cloudflare, AI, agents, RAG, distributed systems, self-hosting.
