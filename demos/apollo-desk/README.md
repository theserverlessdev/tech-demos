# Apollo desk

This demo is a browser desk that talks to an Apollo-style brain on Cloudflare. It is a slice of
[galfrevn/apollo](https://github.com/galfrevn/apollo), "the open-source brain for physical agentic devices".
Upstream connects an ESP32 desk with a round screen. This demo puts that desk in the browser. The brain is one
Agents SDK `Agent` with its own SQLite database.

- **Live:** <https://tech-demos.theserverless.dev/demos/apollo-desk/>
- **Subdomain:** <https://apollo-desk.tech-demos.theserverless.dev/>
- **Plan:** [PLAN.md](./PLAN.md) maps each chapter of the Apollo handbook to this slice.

The demo runs on Workers Paid. It does not use Workers for Platforms, Containers, or Vectorize.

## What this demonstrates

**Pattern.** One Agents SDK Durable Object per desk runs the voice turn — speech to text, a tool loop, then speech — and stores SQLite memory with vector recall, schedules, and a confirmation gate. The desk runs an MCP-style JSON-RPC tool server (`tools/call`) that the brain calls on the same WebSocket.

**What you can do**

- Hold to talk, type, or tap a suggested turn.
- Save a fact, a list item, or a timer, then refresh and see them return from the Durable Object.
- Ask it to change the volume. The brain calls `tools/call` on the desk.
- Ask it to forget everything — facts, lists, conversation, location, timers, and reminders — and confirm or cancel within 30 seconds.
- Open the console for the SQLite transcript, vector scores, schedules, and the turn trace.

**What you could build**

- A voice appliance whose tools live on the device and whose memory lives in one Durable Object.
- A personal list and timer that survive a refresh.
- An agent that asks before it runs an unsafe tool.

**Limits**

- The browser is a stand-in for the ESP32 desk. There is no physical device.
- Workers AI spend is metered by a shared daily budget. A Turnstile check is required before any AI path. Each network (IPv4 address or IPv6 /64) can use at most 15% of the day's budget, and each desk is capped at 60 turns per UTC day. Without those caps, one visitor could use up the shared budget for everyone.
- Vector recall is cosine similarity over embeddings stored in the Durable Object, not Vectorize.

![The desk after a turn](./artifacts/01-desk-turn.png)

## What a visitor sees

1. The page opens a desk at a random `?desk=` link. The link is the capability for one Agent instance.
2. Hold the talk button or the space bar and speak. Or type, or click a suggested turn.
3. The face changes state: listening, thinking, speaking. Captions show each tool as it runs, and the reply plays aloud.
4. Tell Apollo a fact, set a timer, save a city, or add to a list. Refresh the page. The conversation, the facts,
   the list, and the timer arc come back from the Durable Object.
5. Ask it to turn the volume down. The brain sends a JSON-RPC `tools/call` to the MCP-style tool server that runs in the desk.
6. Ask it to forget everything. That tool is unsafe, so the desk shows Yes and No for 30 seconds. Confirming clears facts, lists, conversation, the saved city, timers, and reminders.
7. Tap the screen for the clock and weather. Swipe the screen to change the speech mode and the accent colour.
8. The console shows the SQLite transcript, the facts with their vector scores, the schedules, a turn trace with
   token costs, and every wire frame.

## Architecture

```
browser desk (face, mic, speaker, MCP-style tools/call)
      │  AgentClient WebSocket: JSON device frames + 16 kHz PCM binary frames
      ▼
Worker  ── strips /demos/apollo-desk, checks Origin, CSP, routeAgentRequest
      ▼
Apollo Agent (Durable Object, SQLite)
  ├─ hello: Turnstile siteverify, then a verified session
  ├─ turn loop: whisper-large-v3-turbo → glm-5.3-flash with tools (3 rounds, 4 calls/round) → melotts
  ├─ tables: messages, memories (+384-dim vector BLOB), list_items, pending_confirmations, pending_device_messages
  ├─ this.schedule(): timers, reminders (20 max), confirmation expiry
  ├─ setState(): speech mode, location, thread, device settings
  ├─ @callable inspect() and probeMemory() for the console
  └─ Meter DO: one shared daily Workers AI budget, 15% per IP
```

| File | Role |
|---|---|
| `src/worker/index.ts` | Base path, Origin check, CSP, agent routing, and static assets |
| `src/worker/apollo.ts` | The `Apollo` Agent: device protocol, turn loop, tool router, confirmations, schedules, MCP-style bridge, and memory |
| `src/worker/turnstile.ts` | Siteverify for the hello frame. Rejects the test secret off localhost |
| `src/worker/tools.ts` | The tool catalog. Each tool has a Zod schema, a safety level, and a caption |
| `src/worker/memory.ts` | Embeddings, cosine recall, and keyword recall |
| `src/worker/voice.ts` | The WAV header, speech to text, and text to speech |
| `src/worker/meter.ts` | The daily AI budget |
| `src/worker/weather.ts` | Open-Meteo geocoding and forecast |
| `src/shared/protocol.ts` | The wire contract, speech modes, and the face emotion map |
| `src/client/desk.ts` | The desk, the MCP-style `tools/call` replies, and the console |
| `src/client/face.ts` | The glyph face on a canvas |
| `src/client/audio.ts` | Microphone capture at 16 kHz, playback, and earcons |

## Run it

```bash
bun install
cd demos/apollo-desk
bun run dev          # builds the client, then runs wrangler dev on :8787
bun run typecheck
bun run deploy
```

The Workers AI binding always calls the remote service, even in `wrangler dev`.

Smoke test. The script acts as a desk over the WebSocket:

```bash
bun run scripts/smoke.ts http://127.0.0.1:8787
bun run scripts/smoke.ts https://tech-demos.theserverless.dev/demos/apollo-desk --voice path/to/16k-mono.wav
```

## Cost guards

- The `Meter` Durable Object holds a daily budget for all desks: `AI_DAILY_BUDGET_USD`, default `0.10`. Each IP can spend 15% of that budget.
- A Rate Limiting binding allows 10 turns each minute per IP (`7311`) and 8 per desk (`7465`). Inspect is limited to 60 reads/min (`7466`) and 2/s per socket.
- A desk is capped at 60 turns per UTC day. A model round runs at most 4 tool calls. A desk holds 20 timers and reminders.
- A hold sends 15 seconds of audio or less. A desk keeps 200 facts or fewer and 100 list items or fewer.
- One text turn with a tool costs about $0.0006 on `glm-5.3-flash`. Speech costs less than $0.0001.
- Hello requires a Turnstile token. Production needs `TURNSTILE_SITE_KEY` and the `TURNSTILE_SECRET` Worker secret.

## Deploy

`tech-demos-apollo-desk` is a standalone Worker, because it needs Durable Objects and Workers AI. It has two zone routes:

- `tech-demos.theserverless.dev/demos/apollo-desk*`
- `apollo-desk.tech-demos.theserverless.dev/*`

The hub registry keeps a fallback Dynamic Worker. The fallback sends the visitor to the subdomain if the path route is missing.

Production still needs, and this PR does not create:

- Turnstile widget hostnames `tech-demos.theserverless.dev` and `apollo-desk.tech-demos.theserverless.dev`, then `TURNSTILE_SITE_KEY` and `wrangler secret put TURNSTILE_SECRET`
- Rate-limit namespaces `7465` (`DESK_LIMIT`, 8/min per desk) and `7466` (`READ_LIMIT`, 60/min). `7311` (`TURN_LIMIT`) already exists
