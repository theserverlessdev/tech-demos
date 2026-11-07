# x402 Pay

An agent pays for an MCP tool over HTTP 402, and only after you confirm the exact charge. The charge is Base Sepolia test USDC. The signing key stays on the Worker.

This follows [cloudflare/agents `examples/x402-mcp`](https://github.com/cloudflare/agents/tree/main/examples/x402-mcp) and `agents/x402` in `agents@0.33.0`. The page, the confirm binding, and the ledger are original. See [NOTICE.md](./NOTICE.md).

## What this proves

`paidTool` can price an MCP tool. The client receives a payment challenge, and this demo maps that challenge to **HTTP 402**. PayAgent, a Durable Object, signs only after a confirm that names the tool, the arguments, the amount, Base Sepolia, test USDC, and the payee. The tool runs after verification. D1 keeps requested, approved, settled, and failed as different rows. A failure is not shown as paid.

## What you can try

- Call **echo**. It is free.
- Call **square** ($0.01 test USDC) and deny it. The agent does not sign.
- Call square again, confirm, and read the timeline: 402, approval, settlement, result.
- Call **summarize** ($0.02 test USDC). Workers AI runs only after a verified payment.

If the testnet payee or the signing key is missing, paid tools say **setup pending** and nothing is marked paid. A local mock, when you turn it on, is labelled **not a Base Sepolia payment**.

## What you could build

- An MCP tool that charges per call.
- A confirm step before an agent spends.
- A ledger that keeps a failed call distinct from a settled one.

## Run

```sh
bun install
bun run --filter @tech-demos/x402-pay dev
```

`dev` sets the Turnstile test site key and `LOCAL_DEV=1`. Wrangler serves the zone route host, so local mode is that flag plus the absence of `CF-Ray`. A deployed request has `CF-Ray`, and the test token stays rejected. Paid tools stay on setup pending until both secrets exist. The commands that create the database, the secrets, and a disposable testnet key are in [SETUP.md](./SETUP.md). This folder does not create them.

A labelled mock, still not a Base Sepolia payment:

```sh
bun run scripts/mock-facilitator.ts
# then, in another shell, with the printed origin:
bunx wrangler dev --port 8798 \
  --var LOCAL_DEV:1 \
  --var X402_MODE:mock \
  --var MOCK_FACILITATOR_ORIGIN:http://127.0.0.1:8796 \
  --var TURNSTILE_SITE_KEY:1x00000000000000000000AA
```

## Limits

- Network on the wire is `eip155:84532` only. `base`, `base-sepolia`, `eip155:8453`, and `eip155:1` are rejected.
- Token is Base Sepolia test USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. Mainnet USDC is rejected.
- Confirm lasts two minutes, matches one exact binding, and is single-use.
- Session paid cap: 6 per UTC day. Global paid cap: 40 per UTC day. Free echo: 30 per session per UTC day.
- Rate limits: `SESSION_LIMIT` `7631` (6/min), `CALL_LIMIT` `7632` (20/min), `CONFIRM_LIMIT` `7633` (10/min), `READ_LIMIT` `7634` (60/min).
- Turnstile action `x402-pay`. Hosts: `x402-pay.tech-demos.theserverless.dev` and `tech-demos.theserverless.dev`.
- Summary input 1500 characters, output 500. Echo 280 characters.

`paidTool` itself returns an MCP error with `_meta["x402/error"]`, not an HTTP status. `POST /api/call` turns that challenge into HTTP 402. The retry goes through `withX402Client`.
