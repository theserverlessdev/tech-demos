import {
  DUCKDB_MIME_TYPE,
  LogicalTypes,
  MessageType,
  QUACK_VERSION,
  dataChunk,
  decodeMessage,
  encodeMessage,
  splitSignedHugeInt,
  type HugeIntLike,
  type HugeIntParts,
  type QuackMessage,
} from "@quack-protocol/sdk";
import type { Explain } from "../shared/policy";
import type { QueryResult } from "../shared/sql";

export const QUACK_MIME = DUCKDB_MIME_TYPE;

export function decodeQuack(bytes: Uint8Array): QuackMessage {
  return decodeMessage(bytes);
}

export function encodeQuack(message: QuackMessage): Uint8Array {
  return encodeMessage(message);
}

function hugeParts(value: HugeIntLike): HugeIntParts {
  return typeof value === "bigint" ? splitSignedHugeInt(value) : value;
}

function headerOf(message: QuackMessage, connectionId?: string) {
  return {
    connectionId: connectionId ?? message.connectionId,
    clientQueryId: message.clientQueryId,
  };
}

export function connectionResponse(request: QuackMessage, connectionId: string): Uint8Array {
  return encodeMessage({
    type: MessageType.CONNECTION_RESPONSE,
    ...headerOf(request, connectionId),
    serverDuckdbVersion: "lake-catalog",
    serverPlatform: "cloudflare-workers",
    quackVersion: BigInt(QUACK_VERSION),
    heartbeatTimeoutSeconds: 60n,
  });
}

export function successResponse(request: QuackMessage): Uint8Array {
  return encodeMessage({
    type: MessageType.SUCCESS_RESPONSE,
    ...headerOf(request),
  });
}

export function errorResponse(request: QuackMessage, message: string, connectionId?: string): Uint8Array {
  return encodeMessage({
    type: MessageType.ERROR_RESPONSE,
    ...headerOf(request, connectionId),
    message,
  });
}

export function resultResponse(request: QuackMessage, result: QueryResult): Uint8Array {
  const explain: Explain = result.explain;
  const columns = explain.columns;
  const chunk = dataChunk(
    columns.map((column, index) => ({
      name: column.name,
      type: column.kind === "int" ? LogicalTypes.integer() : LogicalTypes.varchar(),
      values: result.rows.map((row) => {
        const value = row[index];
        if (value === null || value === undefined) return null;
        return column.kind === "int" ? Number(value) : String(value);
      }),
    })),
  );
  const results = columns.length ? [chunk] : [];
  return encodeMessage({
    type: MessageType.PREPARE_RESPONSE,
    ...headerOf(request),
    resultTypes: columns.map((column) => (column.kind === "int" ? LogicalTypes.integer() : LogicalTypes.varchar())),
    resultNames: columns.map((column) => column.name),
    needsMoreFetch: false,
    results,
    queryUuid: request.type === MessageType.PREPARE_REQUEST ? hugeParts(request.queryUuid) : { upper: 0n, lower: 1n },
  });
}

export function emptyFetch(request: QuackMessage): Uint8Array {
  return encodeMessage({
    type: MessageType.FETCH_RESPONSE,
    ...headerOf(request),
    results: [],
    totalBatches: 0n,
  });
}
