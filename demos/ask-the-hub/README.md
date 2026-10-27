# Ask the Hub

Ask a question about the tech demos. Cloudflare AI Search reads every demo `README.md` and `PLAN.md` from the R2 bucket `tech-demos-hub-docs` and streams an answer. The Worker does not embed documents or keep its own vector index.

## What this proves

Managed RAG over R2, with zero vector plumbing.

## Run

```sh
bun install
bun run --filter @tech-demos/ask-the-hub dev
```

`DEV=1` on that command accepts Cloudflare's dummy Turnstile token on localhost. Production leaves `DEV` empty, so dummy and localhost tokens are rejected. Set `TURNSTILE_SECRET` to the shared widget secret before a real deploy. This repo does not create the bucket, the AI Search instance, or the rate-limit namespaces.

Sync the notes when you are ready to index them:

```sh
R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... node demos/ask-the-hub/scripts/sync-docs.mjs --dry-run
node demos/ask-the-hub/scripts/sync-docs.mjs
node demos/ask-the-hub/scripts/sync-docs.mjs --prune
```

Keys are `<slug>/README.md` and `<slug>/PLAN.md`. Unchanged files are skipped. Removed demos are deleted only with `--prune`.

Point an AI Search instance at the bucket, then set `AI_SEARCH_INSTANCE` in wrangler. The placeholder name is `placeholder-tech-demos-hub-docs`.

## Limits

- Question: trimmed, 1–500 characters. The text is not stored or logged.
- `ASK_LIMIT` namespace `7614`: 8 asks per minute per IP.
- `SEARCH_LIMIT` namespace `7615`: 20 searches per minute per IP.
- `AskCap` Durable Object: 200 asks per UTC day for the whole demo. Over the cap the API returns 429 and the time it resets, midnight UTC.
