# Omni Judge — plan

## Goal

One Workers AI call to `@cf/cloudflare/clef-omni` returns a probability for every allowed answer about a photo, a voice note, or a short video. The page can also time the older chain (Whisper or a vision model, then Clef) on the same image or audio.

## MVP

Ships: phone-first capture and samples, up to five choice questions, Turnstile, R2 media owned by a visitor cookie, D1 judgments, hourly visitor and network caps plus a rolling daily cap, a 24-hour cron delete, and a labelled local stub when `ENVIRONMENT=local`.

Out of scope: accounts, Durable Objects, a classic-chain pass over video frames, and a live deploy.

## Tasks

1. Sniff image, audio, and video bytes and enforce the size and duration caps.
2. Build and parse a Clef-omni choice request from the model docs.
3. Store media in R2 and judgments in D1, with the atomic budget insert and owner-only reads.
4. Phone UI: record or pick a file, presets or custom questions, bar charts, history, comparison.
5. Hub fallback that returns 503 on the demo host, plus README, changelog, and tests.

## Stack

- Workers + static assets, D1, R2, Workers AI, cron. No Durable Object.
- Bun, TypeScript, the Graphite & Ember page the other demos use.
- Local `wrangler.local.jsonc` omits the AI binding so `bun run dev` does not wait on a login. The page labels those results as a stub.

## Deferred

- Frame extraction so the classic chain could see a video.
- A real Turnstile widget and the D1 and R2 resources. Those stay placeholders until the owner creates them.
