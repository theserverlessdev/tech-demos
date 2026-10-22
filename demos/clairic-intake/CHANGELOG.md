# Changelog

## 0.1.2

- A live inbox lease is retried after 65 seconds. The fourth delivery marks the row failed and acknowledges the message. Messages that still fail go to `tech-demos-clairic-intake-dlq`.
- A failed queue send refunds the reserved calls. A failed Llama compare shows no estimated cost. An image with no pasted text says that compare needs text.

## 0.1.1

- A failed Llama compare no longer drops the Clairic result.
- Inbox rows carry Clairic's `state_text` and `truncated` flag. The claim lease is one minute; the queue delay that waits it out arrived in 0.1.2.
- The review list loads on open, polls for about a minute, and has a Refresh button.
- IPv6 addresses share a /64 budget. A shared daily cap of 200 paid calls returns 503 when it is used up.
- `bun run dev:live` uses the Worker name `tech-demos-clairic-intake-dev`.

## 0.1.0

- Intake desk for `@cf/cloudflare/clairic`: paste a document or upload one receipt photo, edit a typed field schema, and read spans, confidence, nulls, estimate bands, and a forecast chart.
- Side-by-side JSON extraction with `@cf/meta/llama-3.2-3b-instruct` (latency, schema validity, estimated cost).
- Optional `@cf/cloudflare/clef` decision: refund, escalate, or approve, from the typed values.
- Twelve bundled documents run through a Queue into D1. The review list can accept or correct a value.
- Turnstile on every model-calling path. Rate-limit namespaces 7503–7509. Per-IP daily budget of 40 paid calls.
- `bun run dev` is a labelled mock. `bun run dev:live` is the path that calls Workers AI.
