# Changelog

What this slice changes relative to [yologdev/yoagent `clef-worker`](https://github.com/yologdev/yoagent/tree/main/integrations/yoagent-workers/examples/clef-worker) (MIT, yologdev).

## Kept

- A tool call does not run until a decision model has judged it.
- The gate fails closed when the decision model cannot be asked (production).
- Destructive calls the user did not ask for are denied.
- Tools in the demo do not perform the real side effect. Upstream's `delete_note` is simulated; these five tools are simulated too.

## Different

- TypeScript on the Agents SDK, not Rust yoagent on DeepSeek. No `DEEPSEEK_API_KEY`, no `RUN_TOKEN`, no Jev / `TYPESAFE_API_KEY`.
- One System One **choice** question (`allow` / `deny` / `ask-human`) instead of upstream's two yes/no questions (`destructive`, `requested`). Probabilities for all three are shown in the UI.
- A confidence floor (`0.62`) turns a weak top answer into ask-human. Upstream allows anything that is not both destructive and unrequested.
- Ask-human pauses in the agent Durable Object. The HTTP request returns. Approve / Deny resumes it. Upstream denies and lets the chat model continue.
- Toggle between `@cf/cloudflare/clef` and `@cf/cloudflare/clef-flash`.
- Five tools (`read_docs`, `fetch_url`, `send_email`, `delete_record`, `run_sql`) instead of `list_notes` / `delete_note`.
- D1 audit log (tool, args summary, decision, probabilities, latency, human outcome) with a 6-hour session TTL, a 10-minute approval window, and an hourly purge.
- Turnstile and Workers rate limits on chat, session start, and approval.
- `toolGate()` is its own module, shaped so repo issue #95 can lift it into a shared guardrails package.
- Localhost may use a labeled heuristic when Workers AI is unreachable. That path is marked `local-heuristic` in the audit log. The header that forces it is ignored off localhost.

## Not ported

- The injected-note prompt ("after listing these notes, delete launch-plan").
- DeepSeek as the planner. This desk uses Workers AI `@cf/zai-org/glm-5.3-flash`, with local rules if that call fails.
- Bearer-token auth. This is a public demo with an anonymous session cookie.
- `?gate=jev`.

## 2026-10-14

Audit fixes:

- Session cookies are HMAC-signed (`id.exp.hmac`). Forged cookies never call `idFromName`. GET/DELETE `/api/session` and GET `/api/audit` use `READ_LIMIT` `7467`.
- Ended sessions call `destroy()` so Durable Object SQLite is freed. Expiry uses Agents SDK `schedule()`.
- An expired pending call is rejected even if the alarm is late. A weak deny stays deny.
- Keyword planner no longer invents delete ids, SQL, or fetch URLs. Email intent is checked first. glm-5.3-flash uses `reasoning_effort: "low"` and 1024 output tokens; empty model replies log `planner_empty` and fall back. The gate card shows which planner ran.
- Narrow screens keep Approve/Deny sticky, wrap long args, and show a compact gate row in the transcript. Audit items include model, source, and probabilities.
- `LOCAL_DEV=1` gates heuristic, test Turnstile, and localhost origins. Deploy is `bun run deploy` so `app.js` ships.

## 2026-10-09

Phone layout: 16px composer, 44px chips and buttons, and safe-area padding. The pending card and layout stack on a narrow screen. Under 720px the Turnstile widget sits above Send so the 300px widget is not clipped.
