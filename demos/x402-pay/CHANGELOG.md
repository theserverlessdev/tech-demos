# Changelog — x402 Pay

This demo follows [cloudflare/agents `examples/x402-mcp`](https://github.com/cloudflare/agents/tree/main/examples/x402-mcp) (MIT) and `agents/x402` in `agents@0.33.0`. The upstream example is a React client and a PayMCP server. This folder keeps the paid-tool pattern and replaces the client, the confirm, and the ledger.

## Architecture

| | examples/x402-mcp | This demo |
| --- | --- | --- |
| Server | `PayMCP` extends `McpAgent`, `withX402` / `paidTool` | Same classes and helpers |
| Client | React, Vite, kumo, `withX402Client` | A small script. `withX402Client` stays inside PayAgent |
| Confirm | Four hex characters, no expiry | Bound to tool, arguments, amount, network, token, payee. Two minutes. Single use |
| Money | Base Sepolia via the public facilitator | Base Sepolia only, and rejected otherwise. Missing secrets stay unpaid |
| Record | None | D1: one row moves through requested, approved, settled, failed, denied, or unknown |
| Visitors | A wallet key in the example environment | Turnstile, an HttpOnly session, no key in the browser |

## What we cut

- The React, Vite, and kumo UI
- `process.env` keys and any user-supplied private key
- Mainnet and any network other than `eip155:84532`
- A facilitator URL the operator can point at an arbitrary host in production

## What we kept

- `withX402`, `paidTool`, and `withX402Client`
- A free tool next to paid tools
- Confirm before the client signs
- The public facilitator `https://x402.org/facilitator` when testnet secrets are present

## 2026-11-07

First demo. Echo is free. Square is $0.01 test USDC. Summarize is $0.02 test USDC and calls Workers AI only after verification. The session API maps the MCP payment challenge to HTTP 402. A retry of the same confirm does not settle again. A mock facilitator exists only on loopback and is labelled as not a Base Sepolia payment.

A crash after settlement may have happened is `unknown`, not `failed`, and is not signed again. A late receipt from that same attempt can still be stored. The global paid cap is charged when an accept owns the row. Replay identity is the payer and the nonce. A public host with mock vars set returns 503. Cleanup of old D1 rows is implemented and tested, and it is not scheduled.

A settle error is also `unknown`. `agents@0.33.0` returns that error as a normal payment-required result, including HTTP 500 and `success: false`, and that result does not prove the transfer was not submitted. The reason string is not used: empty, `PAYMENT_REQUIRED`, and `INVALID_PAYMENT` are unknown too. A success receipt with the wrong network or hash is unknown. A late failure does not replace unknown. Only an accepted receipt does. The page does not show the raw x402 error JSON.
