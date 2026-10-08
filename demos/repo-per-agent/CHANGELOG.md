# Changelog

This demo is an inspired-by slice of [choyiny/gitorange](https://github.com/choyiny/gitorange) (Apache-2.0, by choyiny). It is not a fork and it does not vendor that codebase.

## Different from GitOrange

- One anonymous task, one Agents SDK Durable Object, one Artifacts repository. No orgs, invites, or personal access tokens.
- The agent commits Workers AI edits to `README.md`, `NOTES.md`, and `src/task.ts` only.
- The UI is a commit log and a unified diff, plus a 10-minute read-only clone token.
- D1 stores tasks and an activity log. A 15-minute cron deletes expired repos and their rows (6 hours, 3 repos per browser).
- Turnstile and Workers rate limits sit on create and run. Token mint is rate limited and tied to the visitor cookie.
- No pull requests, Actions, Containers, Git LFS, Email Sending, or OAuth MCP server.

## Same idea

Repositories are Artifacts repos. Git clients clone them with a repo-scoped token. The worker pushes commits as Git packs over smart HTTP, which is the Artifacts data plane.
