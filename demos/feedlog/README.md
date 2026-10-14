# Feedlog slice

A public feedback board on Cloudflare Workers. This is a **small demo** inspired by [linkcraftstudio/feedlog](https://github.com/linkcraftstudio/feedlog) (MIT, by linkcraftstudio), not a fork of that app. The note that pointed at it: [on X](https://x.com/ceoplanet519/status/2087056479459119500).

- **Live:** <https://tech-demos.theserverless.dev/demos/feedlog/>
- **Subdomain:** <https://feedlog.tech-demos.theserverless.dev/>
- **Plan:** [PLAN.md](./PLAN.md)
- **What changed vs upstream:** [CHANGELOG.md](./CHANGELOG.md)

Walkthrough stills and a short video: [artifacts/](./artifacts/).

## What this demonstrates

**Pattern.** D1 holds posts, one vote per visitor cookie, and changelog rows. Workers AI embeds the title and body into Vectorize so the compose box can list similar posts. If those bindings do not answer, the same endpoint falls back to word overlap. Images stay off the public board until an admin approves them.

**What you can do**

- Read the seeded ideas, vote once from this browser, and open the roadmap and changelog.
- Write a post (three live posts per browser) and watch similar posts appear as you type.
- Attach a JPEG, PNG, GIF, or WebP under 1.5 MB. It stays hidden until an admin approves it.
- Type a near-copy of a seeded title (try "Dark mode for the roadmap") and see it flagged as a possible duplicate.

**What you could build**

- A public roadmap with one vote per browser and an admin takedown path.
- A changelog next to the requests that prompted it.
- A request form that warns when a near-duplicate already exists, with images held for review.

**Limits**

- The board holds 80 posts. The oldest visitor post is deleted first when it is full, so a post can vanish before 14 days.
- Visitor posts expire after 14 days. An hourly cron deletes the post, its votes, its R2 object, and its vector.
- There is no account. The voter id is an HttpOnly cookie. Clearing cookies allows a second vote. Display names that contain `@` are rejected.
- Images are not public until an admin approves them. JPEG EXIF (including GPS) is stripped.
- Similarity in local `wrangler dev` is word overlap, because this Wrangler does not simulate Vectorize. Production uses the index when the bindings answer.
- Admin status, image review, and delete belong on `feedlog.tech-demos.theserverless.dev`. The shared hub origin can be read by other demos on that host.

## What it proves

| Binding | What the demo does with it |
| --- | --- |
| **D1** | Posts, one vote per visitor, changelog entries, gate-use counters. Five seeded ideas plus two changelog entries. Visitor posts expire after 14 days. Cap of 80 visible posts and 3 live posts per cookie. |
| **R2** | Optional JPEG, PNG, GIF, or WebP on a post. 1.5 MB cap. Magic-byte check. Hidden until approved. |
| **Workers AI** | `@cf/baai/bge-small-en-v1.5` embeds the title and body (384 dimensions). |
| **Vectorize** | Cosine index `tech-demos-feedlog`. Similar posts while you type. Vectors are deleted when the post expires. |
| **Rate limits** | Separate limits for new posts, votes, similarity checks, and admin writes (`7341`–`7344`). |
| **Turnstile** | Required to mint the session gate (similar + one create) or to send a fresh token on create. |
| **Cron** | Hourly sweep deletes expired visitor posts, old seed votes, expired gates, orphaned R2/vector keys, and their rows. |

If Workers AI or Vectorize throws (local dev has no Vectorize simulation), similarity falls back to word overlap and the page says so. That is a local/dev path, not what a visitor sees on the live index.

The UI is Graphite & Ember: background `#0e0e11`, ember `#c2410c`, Bricolage Grotesque and Hanken Grotesk. **Contact** goes to [theserverless.dev/contact](https://theserverless.dev/contact).

## How it works

```text
browser ── HTTPS ──► Worker
                      ├─ /api/posts, votes, changelog ─► D1
                      ├─ images (approved only) ───────► R2
                      ├─ /api/similar and index ──────► Workers AI → Vectorize
                      └─ admin status / approve / delete / changelog ─► ADMIN_TOKEN

cron (hourly) ──► delete expired posts, old seed votes, R2 objects, vectors
```

Hash routes (`#/board`, `#/roadmap`, `#/changelog`) keep asset URLs relative, so the same build works at `/demos/feedlog/` and at the subdomain root.

Anonymous visitors get an HttpOnly `fl_vid` cookie. It is a random id, not an account. Display names that contain `@` are rejected. Logs do not include the cookie, the admin token, or the Turnstile token.

A Turnstile pass mints a 10-minute `fl_gate` cookie bound to that visitor. The cookie is not a bearer pass: D1 holds remaining similar checks (30) and a single create credit. Creating a post spends that credit, or a fresh Turnstile token.

## Local

```bash
cd demos/feedlog
bun install
bun run dev
```

Local `wrangler dev --local` does not open a remote proxy. `bun run dev` writes `.dev.vars` (gitignored) with Cloudflare’s always-pass Turnstile test keys, the local admin token `dev-feedlog-admin`, and `GATE_SECRET=dev-feedlog-gate`. Wrangler often binds `http://127.0.0.1:8787`, so the loopback fallbacks apply too. Workers AI and Vectorize have no local simulation in this Wrangler, so similarity answers with word overlap until the Worker is deployed. The compatibility date is `2026-09-10` because the Wrangler pinned in this repo (4.129) rejects anything newer.

```bash
bun test http.test.ts
bun run scripts/smoke.ts http://127.0.0.1:8787
```

On `127.0.0.1` / `localhost` only, when the secrets are unset:

- Turnstile uses Cloudflare’s always-pass test site key `1x00000000000000000000AA` and secret `1x0000000000000000000000000000000AA`.
- The admin token is `dev-feedlog-admin`.
- The gate secret is `dev-feedlog-gate`.

Any other host fails closed until `TURNSTILE_SECRET`, `TURNSTILE_SITE_KEY`, `ADMIN_TOKEN`, and `GATE_SECRET` are set. Do not ship the loopback tokens.

`scripts/smoke.ts` against localhost uses the documented dummy token and cleans up the posts it creates. Against a deployed Worker it runs only reads and negative checks (health, config, list, 403s, 401, 404). It will not vote, post, publish a changelog entry, or call cleanup unless you pass `--allow-writes`.

## Deployed

The Worker is live. These resources already exist on the owner account:

| Resource | Name |
| --- | --- |
| D1 | `tech-demos-feedlog` (`755a07de-470e-48b4-9d0f-20d86b69ff10`) |
| R2 | `tech-demos-feedlog` |
| Vectorize | `tech-demos-feedlog` (384 dimensions, cosine) |
| Rate limits | `7341`–`7344` (this demo keeps them; other demos are moving off this range) |

`TURNSTILE_SITE_KEY` is the public var in `wrangler.jsonc`. `TURNSTILE_SECRET`, `ADMIN_TOKEN`, and `GATE_SECRET` are Worker secrets. The owner holds them. No secret is in the repo.

Routes:

- `tech-demos.theserverless.dev/demos/feedlog*`
- `feedlog.tech-demos.theserverless.dev/*`

`workers_dev` is off so the `*.workers.dev` hostname is not a third public entry.

To redeploy from this folder, with the owner account (unset any other API token):

```bash
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN bun run deploy
```

Then redeploy the hub (`apps/hub`) if the gallery card is missing. The zone route wins when it exists. The registry source only redirects to the subdomain if that route is missing.

After deploy: apply D1 migration `0002_votes_visitor.sql` (included in `bun run deploy`), set `GATE_SECRET` if it is not set, and confirm the five seed ids exist in Vectorize (`getByIds`). If they do not, delete the `vectors_seeded` meta row so the next request can index them.

The embedding model and the index are both 384 dimensions. Changing the model means creating a new index.
