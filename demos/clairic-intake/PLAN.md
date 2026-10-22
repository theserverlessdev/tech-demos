# Clairic Intake — plan

## Goal

An intake desk on Workers that turns a messy support email or a receipt photo into typed values with source spans, confidence, and honest nulls, then optionally asks Clef what to do.

## Model check (before building)

`@cf/cloudflare/clairic` is a Workers AI preview (changelog and model page, 19 Oct 2026; blog [Clairic extraction model](https://blog.cloudflare.com/clairic-extraction-model/)). It is usable from `env.AI.run("@cf/cloudflare/clairic", …)`.

Confirmed from the model page, `schema-input.json`, and `schema-output.json`:

- **Input** (`required`: `model`, `fields`): `model` (`clairic` or `@cf/cloudflare/clairic`), `state` (text; may be empty only when images are sent), `fields` (at least one; names `^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`), `images` (max 4; data URL or `{content_type, base64}`; PNG/JPEG/WebP; remote URLs are not accepted), `reference_date` (ISO date), `options.include_quantiles`, `options.return_state_text`.
- **Field types**: `text`, `number`, `date`, `time`, `datetime`, `duration`, `list`, `estimate`, `forecast`.
- **Field settings**: `instructions`, `unit`, `integer`, `decimals` (0–6), `items` (`text`|`number`|`date`, required for `list`), `min`/`max` (required for estimate and forecast), `step`, `scale` (`linear`|`log`), `null_threshold` (0 exclusive–1), `horizon` (1–64), `interval` (`step`|`minute`|`hour`|`day`|`week`|`month`|`quarter`|`year`).
- **Output**: `answers` keyed by field (`value` null when the input does not determine it), plus `truncated`, optional `state_text`, and `usage` (`input_tokens`, `output_tokens` required; also `state_tokens`, `image_tokens`, `schema_tokens`, `passes`). Scalar answers include `p_null`, `confidence`, `guess`, and `span`. Lists include `spans`. Estimates and forecasts include `median` and an 80% interval (`p10`–`p90`). Forecast blog examples return those as arrays, one entry per step; the schema also describes `steps`.
- **Pricing**: $0.10 per million input tokens. No output-token charge. Context window 65,536. One forward pass; fields that do not fit in one 8,192-token pass are split server-side.
- **Not a promise of correctness.** Confidence, `p_null`, and intervals are the review signal. Arithmetic beyond one or two steps is still weak.

Comparison model: `@cf/meta/llama-3.2-3b-instruct` (small instruct, still on the model page at $0.0509 / $0.335 per million input / output tokens), JSON object mode. Decision model: `@cf/cloudflare/clef`, same choice-question shape as clef-gate (`state` + `questions.*.criteria`), options `refund` / `escalate` / `approve`. Clef returns probabilities, not prose. The desk shows the winning policy line and the three probabilities as the reason.

## MVP

Ships:

- Paste text or upload one receipt/invoice image (sniffed PNG/JPEG/WebP, stored in R2, deleted after one day by cron; lifecycle command documented because wrangler has no lifecycle field).
- Bundled samples: support email, invoice, insurance claim, receipt photo, unclear note.
- Visual field editor with presets: invoice, support ticket, insurance claim. Add and remove typed fields.
- Clairic results: values, source highlights colored by confidence, null and low-confidence flags, estimate band, forecast chart.
- Side-by-side Llama 3.2 3B JSON extraction: latency, schema-valid or not, estimated cost.
- Optional Clef decision from the typed values (not the raw email).
- Batch: 12 bundled inbox docs through a Queue into D1, with a review list (accept / correct). Local dev also drains the queue inline so the page does not depend on consumer timing. The consumer is idempotent.
- Turnstile on extract, decide, and batch. Site key var `TURNSTILE_SITE_KEY` (production value is the placeholder string `TURNSTILE_SITE_KEY`). Secret `TURNSTILE_SECRET`. Local dev uses Cloudflare’s always-pass test pair.
- Rate limits on unused namespace ids **7503–7509** (7501 and 7502 are partyserver). Per-IP daily budget of 40 paid calls in D1.
- Input caps. No URL fetching. Rendered text is escaped; highlights go through `escapeHtml` before `innerHTML`. Everything else uses `textContent`.
- `ENVIRONMENT=local` uses a labelled mock. `bun run dev:live` is the only local path that calls Workers AI. Tests and smoke stay on the mock so they do not bill.

Out of scope: accounts, Durable Objects, Workers for Platforms, fetching document URLs, a real Turnstile widget key, creating the remote D1/R2/Queue (placeholder id, deploy checklist in the README).

## Tasks

1. Validate field specs, images, spans, budget, and rate-limit decisions in shared modules.
2. Worker: Turnstile, limits, R2 put, Clairic / Llama / Clef (or mock), Queue consumer, D1 review rows, hourly cleanup.
3. Phone-first page: schema editor, highlights, comparison, decision, review queue.
4. Tests, typecheck, build, local smoke.
5. 390px screenshots (input, highlighted results, comparison, review queue) and a short H.264 video.
6. Hub card via `redirectSource`.

## Stack

- Workers + static assets, D1, R2, Queues, Workers AI, cron, rate limiting, Turnstile. No Workflow: each inbox doc is independent, so a Queue consumer is the smaller fit. No Containers, no Workers for Platforms.
- Bun, TypeScript, the Graphite & Ember page the other demos use. No new UI kit.
- Placeholder D1 id `00000000-0000-4000-8000-000000007560` (not all zeros, so local wrangler still applies migrations). Replace it on deploy.

## Deferred

- More than one image in the form (the API cap is 1; the model allows 4).
- `include_quantiles` (the 80% interval is enough for the chart).
- A shared `@tech-demos/guardrails` package. `guardFailure()` is a pure helper with no I/O, same idea as clef-gate `toolGate()`, so that package can re-export it later.
