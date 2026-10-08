# Agent Mail — guide for agents

You read and send mail for one agent. You do not create users, agents, or inboxes. Your owner does that in the panel.

## Auth

Send `Authorization: Bearer am1_...` on every `/v1` call except `GET /v1/openapi.json`.

The key works only for this agent's inboxes. A missing, revoked, or unknown key returns `401`. An inbox that belongs to another agent returns `404`.

The panel at `/admin` uses Cloudflare Access. Do not send your API key there.

## Read mail

1. `GET /v1/me` returns your agent id and inbox ids.
2. `GET /v1/inboxes/{id}/threads` lists threads. `startedBy` is `external` when the other party wrote first.
3. `GET /v1/inboxes/{id}/threads/{threadId}` returns the messages.
4. `GET /v1/inboxes/{id}/messages?since={seq}` returns messages after a cursor. The cursor is the `seq` field.
5. `GET /v1/inboxes/{id}/wait?since={seq}&timeout=20` waits up to 20 seconds for new mail. Max timeout is 25 seconds.
6. `GET /v1/inboxes/{id}/messages/{messageId}/raw` returns the raw `.eml` file.
7. `GET /v1/inboxes/{id}/messages/{messageId}/attachments/{index}` returns one file.

## Send mail

`POST /v1/inboxes/{id}/send`

```json
{ "to": ["ada@example.com"], "subject": "Hello", "text": "Hello" }
```

`cc`, `html`, `threadId`, and `inReplyTo` are optional.

`POST /v1/inboxes/{id}/threads/{threadId}/reply`

```json
{ "text": "Thanks" }
```

If you omit `to`, the reply goes to the last external sender.

A `201` body has `"outcome": "sent"`. A `202` body has `"outcome": "drafted"`, a `draftId`, a `reason`, and a `statusUrl`. Only an owner approval sends a draft.

Your owner sets one of these policies:

- `auto` — the API send goes out now.
- `draft` — the API send becomes a draft.
- `reply_only_auto` — a reply in a thread the other party started goes out now. Every other send becomes a draft.

These rules apply to every policy:

- A recipient on the block list returns `403`. No draft is stored.
- A kill switch, a daily cap, or an allow list miss stores a draft. Approval does not send while a kill switch is on.
- The daily cap counts only mail that actually goes out.

## Draft status

`GET /v1/drafts/{id}`

`status` is `pending`, `sent`, or `rejected`. `sentMessageId` is set after approval.

## Errors

The body is `{ "error": { "code": "...", "message": "..." } }`.

| Status | Meaning |
| --- | --- |
| 400 | The JSON or a field is not valid. |
| 401 | The API key is missing, unknown, or revoked. |
| 403 | A block list, or a panel action you cannot do. |
| 404 | The inbox, thread, message, or draft is not yours. |
| 409 | The inbox is disabled, or approval hit a kill switch or cap. |
| 502 | The mail provider did not accept an approved draft. The draft stays pending. |

## Webhook

If your owner set a webhook, a new inbound message sends `POST` with `X-Agent-Mail-Signature: sha256=<hex>`. The hex is HMAC-SHA256 of the raw body, using the secret shown once in the panel. The body has ids, the sender, the subject, and the time. It does not include the message text.
