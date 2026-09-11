# Headlines

Headlines shows the Hacker News front page and an optional three-line AI digest. The gadget runs with `globalOutbound: null`, so it cannot reach the internet by itself. It asks the WEB gatekeeper for `hn.algolia.com`, and a person must approve each request in the Activity panel of the shell.

## Methods

- `getState()` returns `{ items: Item[], fetchedAt: number | null, summary: string | null, status: Status }`.
  - `Item` is `{ id: string, title: string, url: string, host: string, points: number, comments: number, author: string, createdAt: number }`. `createdAt` is a Unix time in seconds.
  - `fetchedAt` is the time of the last refresh in milliseconds, or `null`.
  - `summary` is three lines that start with `"- "`, or `null`.
  - `Status` is `{ phase: "idle" | "awaiting-approval" | "fetching" | "summarizing" | "error", message?: string }`.
- `refresh()` returns the new state. It calls `WEB.getJson()` for the front page (20 stories) and waits until a person approves the request.
  It replaces the stored items and deletes the old summary.
  It throws `"Denied: ..."` if a person denies the request. It throws if the WEB gatekeeper is not connected.
- `summarize()` returns the new state. It sends the top 12 titles to `AI.complete()` and stores a three-line digest.
  It throws if there are no items or if the AI gatekeeper is not connected.
- `subscribe(callback: RpcTarget)` returns nothing. The callback receives `stateChanged(state)` after each status change and each write.

## Notes for the agent

- Call `refresh()` before `summarize()` when `items` is empty.
- Tell the user to approve `hn.algolia.com` in the Activity panel. `refresh()` does not return until a person decides.
- The gadget runs one request at a time. A second `refresh()` joins the refresh in flight. A `summarize()` during a refresh throws a busy error.
