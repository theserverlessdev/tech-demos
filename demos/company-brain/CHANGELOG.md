# Changelog — company-brain vs Company Brain

This demo is a slice inspired by [supermemoryai/company-brain](https://github.com/supermemoryai/company-brain) (Apache-2.0, by supermemoryai). Upstream is an org-scoped Slack teammate: a Worker receives events and a `CompanyBrainAgent` Durable Object owns turns, tools, approvals, and connector state. This repo is a **hosted sandbox** that shows per-org memory on Workers Paid, without those connectors.

Announcement: https://x.com/DhravyaShah/status/2103668051468300701

## Architecture

| | Company Brain (upstream) | This demo |
| --- | --- | --- |
| Runtime | Worker plus one Agents SDK Durable Object per org | Same shape, class name `Org` |
| Ingress | Slack events, plus Linear and GitHub connectors | Manual add, and `POST /api/orgs/:id/ingest` with a hashed token |
| Memory | Connector writeback, search, tags, separate database | DO SQLite `facts` and `decisions` only |
| Answers | Tool loop, triage, approvals, step budget | One Workers AI call over retrieved rows. No tools |
| Tenancy | A customer's long-lived org | One sandbox per visitor. Session token. 24 hour alarm wipe |
| Auth | Slack install and product accounts | Turnstile on create and chat. Bearer or HttpOnly cookie |
| Rate limits | Product billing and cooldowns | Workers rate-limit bindings on create, chat, write, and read |
| UI | Slack | Graphite & Ember static chat + memory panes |

## What we cut

- Slack, Linear, and GitHub connectors
- Triage, chime, proactivity, and approval suspension
- Tool calling, sandbox, and schedulers beyond the expiry alarm
- Postgres and any shared memory across orgs
- Billing, fibers, and turn recovery
- Workers for Platforms / dispatch namespaces

## What we kept (simplified)

- One Durable Object per org as the isolation boundary
- Durable facts and decisions the model is allowed to use
- A reply that cites those rows, or refuses when they do not answer
- An ingest path for something that is not the browser, without a connector

## Branding

Hub Graphite & Ember. Background `#0e0e11`, ember `#c2410c`, Bricolage Grotesque and Hanken Grotesk. Contact links to https://theserverless.dev/contact.
