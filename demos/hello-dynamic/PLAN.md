# Plan — hello-dynamic audit fixes

## Goal

Close the Opus audit of `demos/hello-dynamic` (origin/main @ 279668d): 390px layout, on-page name input, hub POST stream noise, honest copy, and listed nits. No deploy, no new repo, no Cloudflare dashboard changes.

## Single-user MVP

- In: wrap/truncate a 64-code-point `?name=` at 390px; GET form so a phone does not edit the URL; 405 + body-less forward so a POST cannot throw after the response; copy that matches isolate reuse, the hit counter, and `globalOutbound: null`.
- Out: Workers Cache, dashboard/route edits, a second loader demo.

## Tasks

1. Cap `?name=` on Unicode code points, default empty/whitespace to `world`, wrap `h1`, 44px tap targets, `100dvh`, meta CSP, GET form + `?name=Ankur` link.
2. Module-scope isolate hit counter so the page proves it came from the loaded worker.
3. Hub: reject non-GET/HEAD loader requests before `LOADER.get`; `forwardToLoader` does not attach a body.
4. Registry / README / gallery badge / `modules.d.ts` wildcard / root test glob — honest copy and copy-as-template nits.
5. Tests for escaping, astral cap, empty name, form, 405, body-less forward. 390px screenshot + video.

## Stack

- Existing hub Worker Loader + this `worker.js` (Workers Paid, no new bindings).

## Deferred

- `cache-control` / Workers Cache (`"cache": { "enabled": true }` is a Cloudflare change).
- Deploy.
