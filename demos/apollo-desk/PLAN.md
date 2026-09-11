# Plan — apollo-desk

## Goal

Build a browser desk that talks to an Apollo-style brain on Cloudflare. The brain is one Agents SDK
`Agent` with SQLite storage. A visitor holds the talk button or types a turn. The brain answers aloud,
remembers facts, runs tools, and keeps the memory after a page refresh.

Upstream is [galfrevn/apollo](https://github.com/galfrevn/apollo). Upstream is "the open-source brain for
physical agentic devices". An ESP32 desk with a round 360×360 screen connects to one `Apollo` Durable
Object over a WebSocket. This demo replaces the ESP32 with a browser simulator. The demo keeps the wire
protocol, the turn loop, the memory model, the tool router, and the MCP device bridge.

## The slice and the Apollo handbook

The left column uses the chapter names from the upstream `documentation/` handbook.

| Handbook chapter | Upstream implementation | This slice |
|---|---|---|
| `runtime/protocol.md` | Zod unions of JSON control frames. PCM audio goes in binary frames. `hello`, `hold_start`, `hold_end`, `text_input`, `gesture`, `confirm`, `abort`, `mcp` go up. `ui_state`, `tts_start`, `tts_end`, `turn_end`, `timer`, `reminder`, `confirm_request`, `dashboard`, `play_effect`, `mcp` go down | The same frame names and fields, checked with Zod. The browser sends 16 kHz s16le PCM in binary frames, as the firmware does |
| `runtime/loop.md` | `runDeskTurn`: STT, then an LLM tool loop of at most 3 rounds, then TTS. A caption goes to the device for each tool | The same loop and the same limit of 3 tool rounds. Each tool sends a `thinking` caption |
| `runtime/voice.md` | OpenRouter `whisper-large-v3`, OpenRouter `deepseek-v4-flash` over SSE, ElevenLabs PCM at 24 kHz with an R2 cache | Workers AI only: `whisper-large-v3-turbo`, `glm-5.3-flash`, and `melotts`. The reply splits into segments of 120 characters or fewer. Each segment comes down as WAV binary frames between `tts_start` and `tts_end` |
| `runtime/face.md` | The UI state sets an emotion and an accent colour. The device draws the eyes, blinks, and the mouth | A round canvas face. It uses the upstream emotion table (`eyeHeightRatio`, `eyeLiftRatio`, `eyeWidthRatio`). The mouth follows the audio level |
| `runtime/persona.md` | A soul prompt and four speech modes. A swipe changes the mode | The same four modes (`default`, `nerd`, `playful`, `warm`) with the upstream accent colours. A swipe gesture cycles them |
| `capabilities/memory.md` | `SessionManager` history, a `memories` SQL table, Vectorize (1536 dims) for facts and thread summaries, and a nightly job that merges old facts | SQLite tables `messages` and `memories` in the Agent. Each fact stores a 384-dim `bge-small-en-v1.5` vector as a BLOB. Recall uses cosine similarity in the Agent, merged with keyword recall |
| `capabilities/threads.md` | A new thread starts after 30 minutes of silence | The same rule. The console shows the thread number |
| `capabilities/tools.md` | `ToolDefinition` objects with `safety: safe \| unsafe`, Zod argument checks, and a confirmation step for unsafe tools | The same shape. `forget_everything` is unsafe. It sends `confirm_request` and expires after 30 s through `this.schedule` |
| `capabilities/weather.md` | `weather_now`, `set_weather_location`, and a dashboard refresh | The same two tools on Open-Meteo, which needs no key. A tap gesture opens the clock and weather dashboard |
| `capabilities/timers.md`, `reminders.md` | `this.schedule(delay, "deliverReminder")`, `listSchedules`, `cancelSchedule`, and a `timer` arc frame | The same Agents SDK calls. The face draws the countdown arc. The desk plays a chime when the schedule fires |
| `capabilities/lists.md` | `add_to_list`, `read_list`, `remove_from_list` on a SQL table | The same three tools |
| `capabilities/mcp.md` | The brain sends JSON-RPC `tools/call` in `mcp` frames to the firmware MCP server (`self.audio_speaker.set_volume`) | The browser desk runs a small MCP server. It answers `tools/call` for `self.audio_speaker.set_volume`, `self.screen.set_brightness`, and `self.get_device_status` |
| `capabilities/sandbox.md`, `coding.md` | `@cloudflare/sandbox` in a Container, opencode, and GitHub PRs | Not in this slice. Containers need owner approval for cost |
| `capabilities/research.md`, `email.md`, `broadcast.md`, `rates.md` | Tavily, Queues, Workflows, Resend, and an exchange-rate API | Not in this slice |
| `operations/auth.md` | A shared device secret and a dashboard secret | The random desk ID in the link is the capability. The Worker checks the `Origin` header |

## MVP scope for one user

- In scope:
  - A desk simulator: round face, captions, hold-to-talk (button or space bar), text input, tap and swipe gestures, and Yes and No buttons for confirmations.
  - A console beside the desk: the thread transcript, the memory inspector (facts, vector size, list items, schedules), the tool trace, and a live log of the wire frames.
  - One `Apollo` Agent for each desk ID. Memory stays after a refresh because the desk ID stays in the URL and in `localStorage`.
  - Tools: `weather_now`, `set_weather_location`, `remember_fact`, `recall_memory`, `set_timer`, `set_reminder`, `list_reminders`, `cancel_reminder`, `add_to_list`, `read_list`, `remove_from_list`, `set_volume`, `set_brightness`, `device_status`, `forget_everything`.
- Out of scope: accounts, a streamed model reply, barge-in during speech, the nightly job that merges facts, thread summaries, research, email, the sandbox.

## Architecture

```
browser desk (face, mic, MCP server) ──AgentClient WebSocket──▶ Worker
      ▲  JSON control frames + PCM binary frames                 │ routeAgentRequest
      │                                                          ▼
      │                                  Apollo Agent (Durable Object, SQLite)
      │                                   ├─ turn loop: whisper → glm-5.3-flash tools → melotts
      │  ui_state · tts · timer · mcp     ├─ tables: messages, memories (+vector BLOB), list_items,
      └───────────────────────────────────┤          pending_confirmations
                                          ├─ this.schedule(): reminders, timers, confirm expiry
console panel ──@callable RPC──────────────┤  state sync: persona, location, counters
                                          └─ Meter DO: global daily AI budget
```

- The desk and the console share one WebSocket. Device frames go through `onMessage`. Console calls use `@callable()` methods.
- The Agent sends `mcp` JSON-RPC requests to the desk and waits up to 5 s for the reply, as upstream does.

## Tasks

1. Worker: static assets, the `/demos/apollo-desk` base path, and agent routing with an origin check.
2. `Apollo` Agent: schema, the device protocol, the turn loop, the tool router, confirmations, and schedules.
3. Memory: messages, threads, facts with vectors, and recall.
4. Tools, which include the MCP device bridge.
5. `Meter` DO and a per-IP turn rate limit.
6. Desk and console UI in vanilla TypeScript, bundled with Bun.
7. A smoke script over the WebSocket.
8. Deploy, register in the hub, and record a screenshot and a video.

## Stack

- **Agents SDK `agents` 0.22.0.** Upstream uses the same `Agent` class, `@callable`, `schedule`, and `routeAgentRequest`.
- **Durable Object SQLite.** It holds all desk memory, so one desk is one database.
- **Workers AI.** The Paid plan includes it, and it removes the need for OpenRouter and ElevenLabs keys.
- **Zod 4.** Upstream checks frames and tool arguments with Zod. `z.toJSONSchema` gives the tool parameters.
- **Open-Meteo.** It gives weather data with no API key.
- **Vanilla TypeScript and Canvas.** The surface is small, so the demo does not need React.

## Cost guards

- Prices: `glm-5.3-flash` costs $0.15 per M input tokens and $0.50 per M output tokens. Whisper costs $0.0005 per audio minute. MeloTTS costs $0.0002 per audio minute. `bge-small` costs $0.02 per M tokens.
- One text turn costs about $0.001. The `Meter` DO holds a global daily budget (`AI_DAILY_BUDGET_USD`, default `0.10`). The worst case is $3 each month.
- The rate limit is 10 turns per minute per IP. A voice turn has a limit of 15 s of audio.
- Each desk keeps 200 facts or fewer and 100 list items or fewer. A timer or reminder has a limit of 24 hours.
- The demo uses no Vectorize index, no Containers, no Browser Rendering, and no Workers for Platforms.

## Deploy

The demo needs Durable Objects and Workers AI, so it is a standalone Worker, `tech-demos-apollo-desk`.
It follows the cloudflare-os pattern:

- `tech-demos.theserverless.dev/demos/apollo-desk*` (zone route)
- `apollo-desk.tech-demos.theserverless.dev/*` (zone route)

The hub registry keeps a fallback Dynamic Worker source. That source redirects to the subdomain.

## Testing

- `bun run typecheck` for the Worker and the client.
- `scripts/smoke.ts` connects over the WebSocket. It sends a text turn, checks a tool call and a stored fact, reconnects, and checks that the memory stayed.
- A manual pass with Playwright for the screenshot and the video.

## Deferred

- TTS that starts while the model still streams, and barge-in during speech.
- Thread summaries, and the nightly job that merges facts.
- A sandbox that runs code. A Dynamic Worker is the Paid-plan path, but it is not in this slice.
- Installed MCP servers through `addMcpServer`.
