# Omni Judge — plan

## Goal

One Workers AI call to `@cf/cloudflare/clef-omni` returns a probability for every allowed answer about a photo, a voice note, or a short video. The bundled presets are sharp, real-world intake tasks that land on a labelled expected answer.

## MVP

Ships: phone-first capture, openly licensed or self-made samples, preset checklists with an expected answer, Turnstile, R2 media owned by a visitor cookie, D1 judgments, hourly visitor and network caps plus a rolling daily cap, a 24-hour cron delete, Clef-omni by default (labelled stub only when `ENVIRONMENT=local`), and a score script that calls real Workers AI only with `--live`.

Out of scope: accounts, Durable Objects, a classic-chain pass over video frames, identity or biometric liveness checks, a live deploy, and any new Cloudflare API resource.

## This cut

Replace the weak self-drawn samples (beeps, a geometric still, a torn-box drawing) with paired real-world presets:

- Expense intake: a legible receipt vs a blurry one
- Product QA: a cracked phone screen vs an intact phone screen
- Delivery: a damaged parcel vs an intact one
- Support voice: an urgent/angry note vs a routine/calm one
- Safety clip: a person falling vs walking normally

Each preset has one question, labelled options, and an expected top answer. Media is CC0, public domain, or generated here, credited in `LICENSES/CREDITS`, kept small, and served as static assets.

## Tasks

1. Source or generate the ten sample files and credit them.
2. Replace the preset and sample tables; group them in the Graphite & Ember UI.
3. Update hub card copy: what it proves, what to try, what you could build.
4. Add a score script that records Clef-omni probabilities only with `--live`, and keep the local stub path.
5. Tune question wording until each preset lands on the expected answer with a clear margin.
6. Verify the page at 390px and capture a screenshot of each preset result.

## Stack

- Workers + static assets, D1, R2, Workers AI, cron. No Durable Object.
- Bun, TypeScript, the Graphite & Ember page the other demos use.
- `bun run dev` and `bun run dev:stub` use `wrangler.local.jsonc` (no routes, labelled stub). `bun run dev:live` uses `wrangler.live.jsonc` (AI binding, no routes).

## Deferred

- Frame extraction so the classic chain could see a video.
- A real Turnstile widget change. Existing keys stay as they are.
