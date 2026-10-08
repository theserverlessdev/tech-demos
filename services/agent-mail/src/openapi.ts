import { originOf } from "./util";

export function openApiSpec(env: Env): Record<string, unknown> {
  const error = { $ref: "#/components/schemas/Error" };
  return {
    openapi: "3.1.0",
    info: {
      title: "Agent Mail",
      version: "1.0.0",
      description: "Invite-only mail API for agents. Send a bearer key. The panel at /admin uses Cloudflare Access, not this key.",
    },
    servers: [{ url: originOf(env) }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      schemas: {
        Error: {
          type: "object",
          properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } },
        },
        SendResult: {
          type: "object",
          properties: {
            outcome: { type: "string", enum: ["sent", "drafted"] },
            messageId: { type: "string" },
            providerMessageId: { type: "string", nullable: true },
            threadId: { type: "string", nullable: true },
            draftId: { type: "string", nullable: true },
            status: { type: "string" },
            reason: { type: "string" },
            statusUrl: { type: "string" },
          },
        },
      },
    },
    security: [{ bearer: [] }],
    paths: {
      "/v1/me": { get: op("Who this key is", "200") },
      "/v1/inboxes": { get: op("List inboxes for this agent", "200") },
      "/v1/inboxes/{id}": { get: op("Read one inbox", "200") },
      "/v1/inboxes/{id}/threads": { get: op("List threads", "200") },
      "/v1/inboxes/{id}/threads/{threadId}": { get: op("Read a thread and its messages", "200") },
      "/v1/inboxes/{id}/messages": {
        get: {
          ...op("List messages after a cursor", "200"),
          parameters: [q("since", "Return messages with seq greater than this value."), q("limit", "Maximum number of messages.")],
        },
      },
      "/v1/inboxes/{id}/messages/{messageId}": { get: op("Read one message", "200") },
      "/v1/inboxes/{id}/messages/{messageId}/raw": { get: op("Download the raw .eml file", "200") },
      "/v1/inboxes/{id}/messages/{messageId}/attachments/{index}": { get: op("Download one attachment", "200") },
      "/v1/inboxes/{id}/wait": {
        get: {
          ...op("Long-poll for new mail", "200"),
          parameters: [q("since", "Cursor from the previous call."), q("timeout", "Seconds to wait. Maximum 25.")],
        },
      },
      "/v1/inboxes/{id}/send": {
        post: {
          ...op("Send or draft a message. The policy chooses the outcome.", "202"),
          requestBody: jsonBody(["to", "subject", "text"]),
          responses: { "201": { description: "Sent" }, "202": { description: "Drafted" }, "403": error },
        },
      },
      "/v1/inboxes/{id}/threads/{threadId}/reply": {
        post: {
          ...op("Reply in a thread. Threading headers are set on send.", "202"),
          responses: { "201": { description: "Sent" }, "202": { description: "Drafted" } },
        },
      },
      "/v1/drafts": { get: op("List drafts for this agent", "200") },
      "/v1/drafts/{id}": { get: op("Read draft status", "200") },
      "/v1/openapi.json": { get: { summary: "This document", security: [], responses: { "200": { description: "OpenAPI document" } } } },
    },
  };
}

function op(summary: string, status: string) {
  return { summary, responses: { [status]: { description: "OK" }, "401": { description: "Missing or bad key" }, "404": { description: "Not in scope" } } };
}

function q(name: string, description: string) {
  return { name, in: "query", required: false, description, schema: { type: "integer" } };
}

function jsonBody(required: string[]) {
  return {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required,
          properties: {
            to: { type: "array", items: { type: "string" } },
            cc: { type: "array", items: { type: "string" } },
            subject: { type: "string" },
            text: { type: "string" },
            html: { type: "string" },
            threadId: { type: "string" },
            inReplyTo: { type: "string", description: "Internal message id or Message-ID header." },
          },
        },
      },
    },
  };
}
