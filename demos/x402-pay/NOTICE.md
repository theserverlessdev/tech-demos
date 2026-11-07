# Notice

x402 Pay in this repo is an original demo. It does not copy the source files from [cloudflare/agents `examples/x402-mcp`](https://github.com/cloudflare/agents/tree/main/examples/x402-mcp). The paid-tool pattern, `withX402`, `paidTool`, and `withX402Client` come from that example and from `agents@0.33.0`.

## agents

`agents` is MIT licensed. Copyright Cloudflare, Inc.

```
MIT License

Copyright (c) Cloudflare, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Model Context Protocol

`@modelcontextprotocol/sdk@1.32.2` is MIT licensed. `@modelcontextprotocol/client@2.4.0` and `@modelcontextprotocol/server@2.4.0` are Apache-2.0. Both are required peers of `agents@0.33.0`. Copyright Anthropic, PBC and the Model Context Protocol contributors.

## @x402/core and @x402/evm

`@x402/core@2.29.0` and `@x402/evm@2.29.0` are Apache-2.0. Copyright Coinbase, Inc. and the x402 contributors. The facilitator called in testnet mode is `https://x402.org/facilitator`.

## viem and zod

`viem@2.57.16` is MIT licensed. Copyright wevm. `zod@4.6.7` is MIT licensed. Copyright Colin McDonnell.

Pinned versions were checked against each package's `license` field at install time. `agents@0.33.0` was published on 2026-11-03. `@x402/*@2.30.0` was published on 2026-11-04 and is inside the three-day install age gate, so this demo stays on 2.29.0.
