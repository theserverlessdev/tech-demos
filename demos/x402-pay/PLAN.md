# x402 Pay

An agent pays for MCP tools over HTTP 402. The visitor confirms the exact charge before the agent signs. Base Sepolia test USDC only.

Reference: [cloudflare/agents examples/x402-mcp](https://github.com/cloudflare/agents/tree/main/examples/x402-mcp) and Agents SDK `agents/x402` in `agents@0.33.0` (published 2026-11-03). This folder is an original demo of that pattern, not a copy of the upstream React example. See [NOTICE.md](./NOTICE.md).

## MVP

A visitor passes the shared Turnstile check and opens a session. Three tools are available:

- `echo` is free.
- `square` is $0.01 test USDC.
- `summarize` is $0.02 test USDC and calls Workers AI after a verified payment.

A paid call with no payment returns **HTTP 402** and a challenge. The confirm step is bound to the tool, arguments, amount, network, token, and payee, expires quickly, and is single-use. The PayAgent Durable Object signs only after that confirm. The tool runs only after verification. A D1 row records requested, approved, and then settled, failed, denied, or unknown. The page shows that timeline.

When the payee address or the signing key is missing, paid tools fail closed and the page says setup is pending. Nothing is labelled paid. A mock facilitator exists only when local mode is explicit. Its result says it is not a Base Sepolia payment.

## Out of scope

Mainnet, other networks, other tokens, and any payee the server did not configure. User wallets, seed phrases, and private-key collection. Real-money funds and production wallets. Workers for Platforms, Containers, and a second Turnstile widget. Deploying, creating Cloudflare resources, and posting publicly. Machine Payments Protocol. Letting the model choose a tool or a price.

## Stack

- Workers Paid, static assets, one Worker. Bun. No React, Vite, or other UI framework. The page is a small script, same shape as the other standalone demos.
- `agents@0.33.0` `withX402` / `paidTool` and `withX402Client`. Peers `@modelcontextprotocol/sdk@1.32.2`, `@modelcontextprotocol/server@2.4.0`, and `@modelcontextprotocol/client@2.4.0`. The installed x402 packages are `@x402/core@2.29.0` and `@x402/evm@2.29.0` (2.30.0 is inside the three-day install age gate). `viem@2.57.16` signs. `zod@4.6.7` describes tool inputs.
- Network on the wire is CAIP-2 `eip155:84532` (Base Sepolia). The SDK also accepts the legacy name `base-sepolia` and normalizes it. This demo accepts only `eip155:84532`.
- Asset is Circle test USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, six decimals. $0.01 is `10000` atomic units. $0.02 is `20000`.
- Facilitator for a real attempt is only `https://x402.org/facilitator`. There is no env override.
- PayMCP and PayAgent are SQLite Durable Objects. The payee and the signing key are read from runtime secrets inside the object. They are not written to agent state, D1, logs, or the browser.
- D1 `tech-demos-x402-pay` is the ledger, the session store, the daily counters, and the timeline. One additive migration.
- Rate limits `SESSION_LIMIT` `7631`, `CALL_LIMIT` `7632`, `CONFIRM_LIMIT` `7633`, `READ_LIMIT` `7634`. pairlane uses `7624`–`7626`.
- Shared Turnstile site key `0x4AAAAAAFRUoj5qDpf7XyIW`, action `x402-pay`, exact hosts `x402-pay.tech-demos.theserverless.dev` and `tech-demos.theserverless.dev`. Loopback is accepted while local mode is on. Wrangler dev rewrites the host to the zone route, so local mode also accepts that host when `LOCAL_DEV=1` and the request has no `CF-Ray`. A deployed request has `CF-Ray`, so the flag does not open local mode there.
- Workers AI model `@cf/meta/llama-3.2-1b-instruct` for the summary. Input and output are capped.

`paidTool` in agents 0.33.0 does not emit an HTTP status. It returns an MCP tool error whose `_meta["x402/error"]` carries the payment requirements. The session API maps that challenge to HTTP 402 so the timeline shows the status the protocol is named for. The retry still goes through `withX402Client`, which places the payment in `_meta["x402/payment"]`. The SDK verifies, runs the handler, then settles. A handler error skips settlement. That is why a failed summary is not marked paid.

The SDK client prefers the configured network and otherwise falls back to every requirement the server offered. The confirm callback here rejects the whole set unless it is exactly one requirement and that requirement matches the stored confirm. The client cap is `20000` atomic units.

## Vertical slices

1. Session after Turnstile. Free `echo` returns the message. No ledger charge.
2. Paid call with no payment returns HTTP 402, stores a requested row, and opens the confirm sheet.
3. Deny, expiry, a wrong binding, or a second session cannot sign.
4. Accept signs, verifies, settles, runs the tool, and appends the timeline.
5. A retry of the same confirm returns the stored row and does not settle again.
6. Missing secrets stay on setup pending. Mock mode is labelled and is not reported as testnet.

## Security boundaries

- The server catalog is the only price list. Client network, token, amount, and payee fields are not trusted.
- Mainnet ids (`eip155:8453`, `eip155:1`, `base`) and mainnet USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` are rejected before a facilitator call and again inside the tool handler.
- The confirm binds tool, canonical arguments, scheme `exact`, network, asset, amount, and payee. It expires in two minutes and moves `requested` to `approved` with a compare-and-set. A second accept does not start a second settlement.
- The browser never receives the signing key, the payment payload, or the signature. The ledger stores a hash of the payer address and the authorization nonce, not the signature bytes.
- Each session is its own PayAgent name plus an HttpOnly cookie. Another session's cookie cannot read the timeline or submit the confirm.
- Paid execution follows a verified payment. A paid tool result that arrives without a challenge is discarded. `paid: true` is set only when the mode is testnet, the facilitator reported success, the network is Base Sepolia, and the transaction is a 66-character `0x` hash. A `mock:` transaction in testnet mode is a failure.
- Summary input is at most 1500 characters. Output is at most 500 characters. One model call per verified attempt. The model runs after verify and before settle. Session quote cap is 6 per UTC day. Global paid cap is 40, charged when an accept owns the row, so a denied quote does not use it. Free calls are capped per session per day.
- Logs are event names and error codes. Bodies, cookies, keys, and payment tokens are not logged.
- Mock mode requires `X402_MODE=mock`, local Turnstile mode, and `MOCK_FACILITATOR_ORIGIN`. Production wrangler config sets none of these. A public host that still has those vars set gets 503 `mock_misconfigured` before a session can pay. A mock result has `paid: false`.
- A settle that may have happened is stored as `unknown`, not `failed`. That covers a crash, a thrown settle, an HTTP 500, a facilitator `success: false`, and a success receipt that is not an accepted Base Sepolia hash. A retry does not sign. A late failure does not replace unknown. A late accepted receipt can still be recorded, and settled stays settled. D1 growth is documented. The purge function is tested and not scheduled.

## Test plan

`bun test` in this package covers:

- free echo
- HTTP 402 and a requested row
- reject unsigned, unapproved, expired, replayed, wrong-chain, and altered payments
- session isolation
- idempotent confirm retry
- session and global caps
- a tool failure before settle leaves `paid: false`. A facilitator `success: false` or an HTTP 500 from settle leaves the row `unknown`, with one verify and no second signature
- missing secrets fail closed
- mock success is labelled and is not testnet
- the official `paidTool` path against a local facilitator: challenge, rejection, one settlement, replay does not settle again

A live Base Sepolia payment runs only when `X402_LIVE_TEST=1` and both secrets are present. Otherwise that case is skipped and reported as not run. It is not replaced with a mock receipt.

Also run, from the repo root, `bun run test`, `bun run typecheck`, and this package's `check:layout` and `verify:selfhost`.

## Layout

```
demos/x402-pay/
  PLAN.md
  README.md
  CHANGELOG.md
  NOTICE.md
  SETUP.md
  wrangler.jsonc
  migrations/0001_ledger.sql
  public/
  src/shared/     # catalog, ids, binding hash
  src/worker/     # PayMCP, PayAgent, HTTP, policy, ledger, Turnstile
  src/client/     # phone-first page
  scripts/check-layout.ts
  scripts/verify-selfhost.ts
  scripts/mock-facilitator.ts
```

The hub card is `apps/hub/src/registry.ts`. The root `test` script includes this package so `bun run test` runs these cases.
