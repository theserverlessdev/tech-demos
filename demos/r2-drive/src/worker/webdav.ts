/**
 * Copyright 2026 abersheeran
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Derived from https://github.com/abersheeran/r2-webdav (Apache-2.0).
 * Locks are stored in the caller-supplied LockStore instead of R2 metadata.
 * Paths, quotas, and content policy are enforced by the bucket wrapper.
 * See CHANGELOG.md.
 */

import { DOMParser } from "@xmldom/xmldom";
import { MAX_LOCK_OWNER_BYTES, MAX_LOCKS_PER_DRIVE, MAX_SHARED_LOCKS_PER_PATH } from "../shared/constants";
import { destinationKey, parentKey, resourceHref } from "../shared/paths";
import { DavStatus, type DavBucket, type DavObject } from "./bucket";
import {
  assertWritable,
  heldLockTokens,
  ifHeaderAllows,
  descendantBlocks,
  escapeXml,
  lockDiscovery,
  lockTokensFrom,
  normalizeLockToken,
  parseTimeout,
  supportedLockXml,
  type LockDepth,
  type LockRecord,
  type LockScope,
  type LockStore,
} from "./locks";
import type { GuardedBucket, SqlRunner } from "./quota";
import { copyMoveBudgetResponse, takeUnits, unitsUsed } from "./requests";

const COLLECTION = "<collection />";
const DAV = "DAV:";
const DEAD = "dead:";
const METHODS = ["OPTIONS", "PROPFIND", "PROPPATCH", "MKCOL", "GET", "HEAD", "PUT", "DELETE", "COPY", "MOVE", "LOCK", "UNLOCK"];

type XmlLike = {
  nodeType: number;
  ELEMENT_NODE: number;
  firstChild: XmlLike | null;
  nextSibling: XmlLike | null;
  localName: string;
  prefix: string | null;
  namespaceURI: string | null;
  toString(): string;
};

type DeadProperty = { namespaceURI: string; localName: string; prefix: string | null; valueXml: string };
type Propfind =
  | { mode: "allprop" }
  | { mode: "propname" }
  | { mode: "prop"; properties: DeadProperty[] };

export type DavCtx = {
  bucket: GuardedBucket;
  locks: LockStore;
  now: number;
  mountPath: string;
  key: string;
  driveExpiresAt?: number;
  sql: SqlRunner;
  driveId: string;
};

export async function handleWebdav(request: Request, ctx: DavCtx): Promise<Response> {
  try {
    return await dispatch(request, ctx);
  } catch (error) {
    if (error instanceof DavStatus) return new Response(error.message, { status: error.status });
    throw error;
  }
}

async function dispatch(request: Request, ctx: DavCtx): Promise<Response> {
  switch (request.method) {
    case "OPTIONS":
      return new Response(null, { status: 200, headers: davHeaders() });
    case "HEAD":
    case "GET": {
      const response = await handleGet(request, ctx);
      return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
    }
    case "PUT":
      return handlePut(request, ctx);
    case "DELETE":
      return handleDelete(request, ctx);
    case "MKCOL":
      return handleMkcol(request, ctx);
    case "PROPFIND":
      return handlePropfind(request, ctx);
    case "PROPPATCH":
      return handleProppatch(request, ctx);
    case "COPY":
      return handleCopy(request, ctx);
    case "MOVE":
      return handleMove(request, ctx);
    case "LOCK":
      return handleLock(request, ctx);
    case "UNLOCK":
      return handleUnlock(request, ctx);
    default:
      return new Response("Method Not Allowed", { status: 405, headers: davHeaders() });
  }
}

function davHeaders(): Headers {
  const headers = new Headers();
  headers.set("Allow", METHODS.join(", "));
  headers.set("DAV", "1, 2");
  headers.set("MS-Author-Via", "DAV");
  return headers;
}

async function readLimited(request: Request, max: number): Promise<Uint8Array | Response> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isFinite(size) || size < 0) return new Response("Bad Request", { status: 400 });
    if (size > max) return new Response("Payload Too Large", { status: 413 });
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    const value = step.value;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return new Response("Payload Too Large", { status: 413 });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function objectBytes(object: DavObject): Promise<Uint8Array> {
  if (object.body instanceof Uint8Array) return object.body;
  if (!object.body) return new Uint8Array();
  return new Uint8Array(await new Response(object.body).arrayBuffer());
}

async function* listAll(bucket: DavBucket, prefix: string, recursive = false): AsyncGenerator<DavObject> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, delimiter: recursive ? undefined : "/", cursor });
    for (const object of page.objects) yield object;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function hasCollection(bucket: DavBucket, key: string): Promise<boolean> {
  if (key === "") return true;
  const resource = await bucket.head(key);
  if (resource?.customMetadata?.resourcetype === COLLECTION) return true;
  const page = await bucket.list({ prefix: `${key}/` });
  return page.objects.length > 0;
}

function isCollection(object: DavObject | null, key: string): boolean {
  if (key === "") return true;
  return object?.customMetadata?.resourcetype === COLLECTION;
}

async function requireWritable(request: Request, ctx: DavCtx, key: string, options?: { ignoreSharedLocksOnTarget?: boolean }): Promise<Response | null> {
  const resource = key === "" ? null : await ctx.bucket.head(key);
  const resourcePath = resourceHref(ctx.mountPath, key, isCollection(resource, key));
  const allowed = ifHeaderAllows(
    request.headers.get("If"),
    await heldLockTokens(ctx.locks, key, ctx.now),
    resource?.etag,
    request.url,
    resourcePath,
  );
  if (!allowed) return new Response("Precondition Failed", { status: 412 });
  const ok = await assertWritable(ctx.locks, key, lockTokensFrom(request), ctx.now, options);
  return ok ? null : new Response("Locked", { status: 423 });
}

async function handleGet(request: Request, ctx: DavCtx): Promise<Response> {
  const directory = ctx.key === "" || new URL(request.url).pathname.endsWith("/");
  if (directory) {
    if (ctx.key !== "") {
      const resource = await ctx.bucket.head(ctx.key);
      if (!resource || resource.customMetadata?.resourcetype !== COLLECTION) return new Response("Not Found", { status: 404 });
    }
    const prefix = ctx.key === "" ? "" : `${ctx.key}/`;
    const names: string[] = [];
    for await (const object of listAll(ctx.bucket, prefix)) {
      if (object.key === ctx.key) continue;
      names.push(object.key.slice(prefix.length));
    }
    return new Response(names.join("\n"), { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const object = await ctx.bucket.get(ctx.key, { onlyIf: request.headers, range: request.headers });
  if (!object) return new Response("Not Found", { status: 404 });
  if (object.preconditionFailed) {
    return new Response(null, { status: request.headers.has("If-None-Match") ? 304 : 412 });
  }
  const ranged = request.headers.has("Range") && object.range !== undefined;
  const headers = new Headers();
  headers.set("accept-ranges", "bytes");
  headers.set("etag", object.etag);
  headers.set("content-type", object.httpMetadata?.contentType ?? "application/octet-stream");
  if (object.httpMetadata?.contentDisposition) headers.set("content-disposition", object.httpMetadata.contentDisposition);
  const body = await objectBytes(object);
  if (ranged && object.range) {
    const start = object.range.offset ?? Math.max(0, object.size - (object.range.suffix ?? 0));
    const end = start + body.byteLength - 1;
    headers.set("content-range", `bytes ${start}-${end}/${object.size}`);
  }
  headers.set("content-length", String(body.byteLength));
  return new Response(body, { status: ranged ? 206 : 200, headers });
}

async function handlePut(request: Request, ctx: DavCtx): Promise<Response> {
  if (ctx.key === "" || new URL(request.url).pathname.endsWith("/")) return new Response("Method Not Allowed", { status: 405 });
  const body = await readLimited(request, 5 * 1024 * 1024);
  if (body instanceof Response) return body;
  const locked = await requireWritable(request, ctx, ctx.key);
  if (locked) return locked;
  const existing = await ctx.bucket.head(ctx.key);
  if (existing?.customMetadata?.resourcetype === COLLECTION) return new Response("Conflict", { status: 409 });
  if (!(await hasCollection(ctx.bucket, parentKey(ctx.key)))) return new Response("Conflict", { status: 409 });
  const stored = await ctx.bucket.put(ctx.key, body, { onlyIf: request.headers, customMetadata: deadOnly(existing?.customMetadata) });
  if (!stored) return new Response("Precondition Failed", { status: 412 });
  return new Response(existing ? null : "", { status: existing ? 204 : 201 });
}

async function handleDelete(request: Request, ctx: DavCtx): Promise<Response> {
  const locked = await requireWritable(request, ctx, ctx.key);
  if (locked) return locked;
  if (await descendantBlocks(ctx.locks, ctx.key, lockTokensFrom(request), ctx.now)) return new Response("Locked", { status: 423 });
  if (ctx.key === "") {
    const keys: string[] = [];
    for await (const object of listAll(ctx.bucket, "", true)) keys.push(object.key);
    if (keys.length) await ctx.bucket.delete(keys);
    return new Response(null, { status: 204 });
  }
  const resource = await ctx.bucket.head(ctx.key);
  if (!resource) return new Response("Not Found", { status: 404 });
  const keys = [ctx.key];
  if (resource.customMetadata?.resourcetype === COLLECTION) {
    for await (const object of listAll(ctx.bucket, `${ctx.key}/`, true)) keys.push(object.key);
  }
  await ctx.bucket.delete(keys);
  return new Response(null, { status: 204 });
}

async function handleMkcol(request: Request, ctx: DavCtx): Promise<Response> {
  const body = await readLimited(request, 1024);
  if (body instanceof Response) return body;
  if (body.byteLength > 0) return new Response("Unsupported Media Type", { status: 415 });
  if (ctx.key === "") return new Response("Method Not Allowed", { status: 405 });
  const locked = await requireWritable(request, ctx, ctx.key);
  if (locked) return locked;
  if (await ctx.bucket.head(ctx.key)) return new Response("Method Not Allowed", { status: 405 });
  if (!(await hasCollection(ctx.bucket, parentKey(ctx.key)))) return new Response("Conflict", { status: 409 });
  await ctx.bucket.put(ctx.key, new Uint8Array(), { customMetadata: { resourcetype: COLLECTION } });
  return new Response("", { status: 201, headers: { Location: resourceHref(ctx.mountPath, ctx.key, true) } });
}

async function handlePropfind(request: Request, ctx: DavCtx): Promise<Response> {
  const raw = await readLimited(request, 64 * 1024);
  if (raw instanceof Response) return raw;
  const parsed = parsePropfind(new TextDecoder().decode(raw));
  if (!parsed) return new Response("Bad Request", { status: 400 });
  let page = `<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:">`;
  let collection: boolean;
  if (ctx.key === "") {
    page += await propfindEntry(ctx, null, "", parsed);
    collection = true;
  } else {
    const object = await ctx.bucket.head(ctx.key);
    if (!object) return new Response("Not Found", { status: 404 });
    collection = object.customMetadata?.resourcetype === COLLECTION;
    page += await propfindEntry(ctx, object, ctx.key, parsed);
  }
  const depth = request.headers.get("Depth") ?? "infinity";
  if (collection && depth !== "0") {
    if (depth !== "1" && depth !== "infinity") return new Response("Bad Request", { status: 400 });
    const prefix = ctx.key === "" ? "" : `${ctx.key}/`;
    for await (const object of listAll(ctx.bucket, prefix, depth === "infinity")) {
      page += await propfindEntry(ctx, object, object.key, parsed);
    }
  }
  page += "\n</multistatus>\n";
  return new Response(page, { status: 207, headers: { "content-type": "application/xml; charset=utf-8" } });
}

async function handleProppatch(request: Request, ctx: DavCtx): Promise<Response> {
  const raw = await readLimited(request, 64 * 1024);
  if (raw instanceof Response) return raw;
  const locked = await requireWritable(request, ctx, ctx.key);
  if (locked) return locked;
  const object = await ctx.bucket.head(ctx.key);
  if (!object || ctx.key === "") return new Response("Not Found", { status: 404 });
  const parsed = parseProppatch(new TextDecoder().decode(raw));
  if (!parsed) return new Response("Bad Request", { status: 400 });
  const metadata = deadOnly(object.customMetadata);
  const okSet: DeadProperty[] = [];
  const okRemove: DeadProperty[] = [];
  const bad: DeadProperty[] = [];
  for (const operation of parsed) {
    if (protectedProperty(operation.property)) {
      bad.push(operation.property);
      continue;
    }
    const id = deadKey(operation.property);
    if (operation.action === "set") {
      metadata[id] = JSON.stringify(operation.property);
      okSet.push(operation.property);
    } else {
      delete metadata[id];
      okRemove.push(operation.property);
    }
  }
  if (metadataSize(metadata) > 1800) return new Response("Insufficient Storage", { status: 507 });
  const failed = bad.length > 0;
  if (!failed) {
    const source = await ctx.bucket.get(ctx.key);
    if (!source) return new Response("Not Found", { status: 404 });
    if (object.customMetadata?.resourcetype === COLLECTION) metadata.resourcetype = COLLECTION;
    await ctx.bucket.put(ctx.key, await objectBytes(source), {
      httpMetadata: object.httpMetadata,
      customMetadata: metadata,
    });
  }
  const statusFor = failed ? "HTTP/1.1 424 Failed Dependency" : "HTTP/1.1 200 OK";
  const groups = new Map<string, DeadProperty[]>();
  for (const property of [...okSet, ...okRemove]) groups.set(statusFor, [...(groups.get(statusFor) ?? []), property]);
  if (bad.length) groups.set("HTTP/1.1 403 Forbidden", bad);
  let xml = `<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:">\n<response><href>${escapeXml(resourceHref(ctx.mountPath, ctx.key, isCollection(object, ctx.key)))}</href>`;
  for (const [status, properties] of groups) {
    xml += `<propstat><prop>${properties.map((property) => emptyProp(property)).join("")}</prop><status>${status}</status></propstat>`;
  }
  xml += "</response></multistatus>";
  return new Response(xml, { status: 207, headers: { "content-type": "application/xml; charset=utf-8" } });
}

async function handleCopy(request: Request, ctx: DavCtx): Promise<Response> {
  return transfer(request, ctx, false);
}

async function handleMove(request: Request, ctx: DavCtx): Promise<Response> {
  return transfer(request, ctx, true);
}

async function transfer(request: Request, ctx: DavCtx, move: boolean): Promise<Response> {
  if (ctx.key === "") return new Response("Bad Request", { status: 400 });
  const header = request.headers.get("Destination");
  if (!header) return new Response("Bad Request", { status: 400 });
  const destination = destinationKey(header, request.url, ctx.mountPath);
  if (destination === null || destination === ctx.key || destination.startsWith(`${ctx.key}/`) || ctx.key.startsWith(`${destination}/`)) {
    return new Response("Bad Request", { status: 400 });
  }
  const sourceLock = await requireWritable(request, ctx, ctx.key);
  if (sourceLock && move) return sourceLock;
  if (move && (await descendantBlocks(ctx.locks, ctx.key, lockTokensFrom(request), ctx.now))) {
    return new Response("Locked", { status: 423 });
  }
  const destLock = await requireWritable(request, ctx, destination);
  if (destLock) return destLock;
  if (!(await hasCollection(ctx.bucket, parentKey(destination)))) return new Response("Conflict", { status: 409 });
  const overwrite = (request.headers.get("Overwrite") ?? "T") !== "F";
  const existing = await ctx.bucket.head(destination);
  if (existing && !overwrite) return new Response("Precondition Failed", { status: 412 });
  const source = await ctx.bucket.head(ctx.key);
  if (!source) return new Response("Not Found", { status: 404 });
  const collection = source.customMetadata?.resourcetype === COLLECTION;
  const depth = request.headers.get("Depth") ?? "infinity";
  if (collection && move && depth !== "infinity") return new Response("Bad Request", { status: 400 });
  if (collection && !move && depth !== "0" && depth !== "infinity") return new Response("Bad Request", { status: 400 });
  const jobs: DavObject[] = [source];
  if (collection && depth === "infinity") {
    for await (const object of listAll(ctx.bucket, `${ctx.key}/`, true)) jobs.push(object);
  }
  // The request already paid for one unit. Each further object costs another, so the total is one per object.
  // A failed charge returns before the destination delete and before any put.
  if (!takeUnits(ctx.sql, jobs.length - 1)) return copyMoveBudgetResponse(ctx.driveId, jobs.length, unitsUsed(ctx.sql));
  if (existing) {
    const removed = await handleDelete(new Request(request.url, { method: "DELETE", headers: lockHeaders(request) }), {
      ...ctx,
      key: destination,
    });
    if (!removed.ok && removed.status !== 404) return removed;
  }
  for (const job of jobs) {
    const loaded = await ctx.bucket.get(job.key);
    if (!loaded) continue;
    const relative = job.key === ctx.key ? "" : job.key.slice(ctx.key.length + 1);
    const target = relative ? `${destination}/${relative}` : destination;
    const body = await objectBytes(loaded);
    const put = await ctx.bucket.put(target, body, {
      httpMetadata: job.httpMetadata,
      customMetadata: deadOnly(job.customMetadata),
      quotaCredit: move ? { bytes: job.size, files: 1 } : undefined,
    });
    if (!put) return new Response("Precondition Failed", { status: 412 });
    if (move) await ctx.bucket.delete(job.key, true);
  }
  if (existing) return new Response(null, { status: 204 });
  return new Response("", {
    status: 201,
    headers: { Location: resourceHref(ctx.mountPath, destination, collection) },
  });
}

function lockHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of ["If", "Lock-Token"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

async function handleLock(request: Request, ctx: DavCtx): Promise<Response> {
  const depthHeader = request.headers.get("Depth");
  if (depthHeader !== null && depthHeader !== "0" && depthHeader !== "infinity") return new Response("Bad Request", { status: 400 });
  const raw = await readLimited(request, 64 * 1024);
  if (raw instanceof Response) return raw;
  const body = new TextDecoder().decode(raw);
  const requestedScope: LockScope = /<shared\b/i.test(body) ? "shared" : "exclusive";
  if (body !== "" && !/<write\b/i.test(body)) return new Response("Bad Request", { status: 400 });
  const tokens = lockTokensFrom(request);
  const locked = await requireWritable(request, ctx, ctx.key, {
    ignoreSharedLocksOnTarget: body !== "" && requestedScope === "shared",
  });
  if (locked) return locked;
  const { timeout, expiresAt } = parseTimeout(request.headers.get("Timeout"), ctx.now, ctx.driveExpiresAt);
  const owner = extractOwner(body);
  if (owner && new TextEncoder().encode(owner).byteLength > MAX_LOCK_OWNER_BYTES) return new Response("Bad Request", { status: 400 });
  const refresh = body === "" ? await findHeldLock(ctx, ctx.key, tokens) : null;
  let resource = refresh ? await ctx.bucket.head(refresh.path) : await ctx.bucket.head(ctx.key);
  if (!resource && ctx.key !== "") {
    if (body === "") return new Response("Bad Request", { status: 400 });
    if (new URL(request.url).pathname.endsWith("/")) return new Response("Conflict", { status: 409 });
    if (!(await hasCollection(ctx.bucket, parentKey(ctx.key)))) return new Response("Conflict", { status: 409 });
    await ctx.bucket.put(ctx.key, new Uint8Array(), { customMetadata: {} });
    resource = await ctx.bucket.head(ctx.key);
  }
  const path = refresh?.path ?? ctx.key;
  const current = await ctx.locks.get(path, ctx.now);
  if (body === "" && !refresh && current.length > 0 && !current.some((lock) => tokens.includes(lock.token))) {
    return new Response("Locked", { status: 423 });
  }
  if (!refresh) {
    if (requestedScope === "exclusive" && current.length > 0) return new Response("Locked", { status: 423 });
    if (requestedScope === "shared" && current.some((lock) => lock.scope === "exclusive")) return new Response("Locked", { status: 423 });
    if ((await ctx.locks.count(ctx.now)) >= MAX_LOCKS_PER_DRIVE) return new Response("Locked", { status: 423 });
    if (requestedScope === "shared" && current.filter((lock) => lock.scope === "shared").length >= MAX_SHARED_LOCKS_PER_PATH) {
      return new Response("Locked", { status: 423 });
    }
  }
  const collection = isCollection(resource, path);
  let depth: LockDepth;
  if (refresh && depthHeader === null) depth = refresh.lock.depth;
  else if (collection) depth = depthHeader === "0" ? "0" : "infinity";
  else depth = depthHeader === "infinity" ? "infinity" : "0";
  const record: LockRecord = {
    token: refresh?.lock.token ?? crypto.randomUUID(),
    path,
    owner: owner ?? refresh?.lock.owner,
    scope: refresh?.lock.scope ?? requestedScope,
    depth,
    timeout,
    expiresAt,
    root: resourceHref(ctx.mountPath, path, collection),
  };
  const next = refresh ? current.map((lock) => (lock.token === record.token ? record : lock)) : [...current, record];
  await ctx.locks.put(record, ctx.now);
  const headers = new Headers({ "content-type": "application/xml; charset=utf-8", "Lock-Token": `<urn:uuid:${record.token}>` });
  if (!refresh) headers.set("Location", record.root);
  return new Response(
    `<?xml version="1.0" encoding="utf-8"?>\n<prop xmlns="DAV:"><lockdiscovery>${lockDiscovery(next)}</lockdiscovery></prop>`,
    { status: refresh ? 200 : 201, headers },
  );
}

async function handleUnlock(request: Request, ctx: DavCtx): Promise<Response> {
  const header = request.headers.get("Lock-Token");
  if (!header) return new Response("Bad Request", { status: 400 });
  if (ctx.key !== "" && !(await ctx.bucket.head(ctx.key))) return new Response("Not Found", { status: 404 });
  const token = normalizeLockToken(header);
  const current = await ctx.locks.get(ctx.key, ctx.now);
  if (!current.some((lock) => lock.token === token)) return new Response("Conflict", { status: 409 });
  const locked = await requireWritable(request, ctx, ctx.key);
  if (locked) return locked;
  await ctx.locks.remove(token, ctx.now);
  return new Response(null, { status: 204 });
}

async function findHeldLock(ctx: DavCtx, path: string, tokens: string[]): Promise<{ path: string; lock: LockRecord } | null> {
  for (const candidate of path === "" ? [""] : [path, ...ancestorsAfter(path)]) {
    const found = (await ctx.locks.get(candidate, ctx.now)).find(
      (lock) => tokens.includes(lock.token) && (candidate === path || lock.depth === "infinity"),
    );
    if (found) return { path: candidate, lock: found };
  }
  return null;
}

function ancestorsAfter(path: string): string[] {
  const out: string[] = [];
  let current = path;
  while (current.includes("/")) {
    current = current.slice(0, current.lastIndexOf("/"));
    out.push(current);
  }
  if (path !== "") out.push("");
  return out;
}

async function propfindEntry(ctx: DavCtx, object: DavObject | null, key: string, request: Propfind): Promise<string> {
  const locks = await ctx.locks.get(key, ctx.now);
  const live = liveProps(object, key, ctx.mountPath, locks, ctx.now);
  const dead = deadProps(object?.customMetadata);
  const ok: string[] = [];
  const missing: string[] = [];
  if (request.mode === "allprop") {
    ok.push(...Object.entries(live).flatMap(([name, value]) => (value === undefined ? [] : [propXml(name, value)])));
    ok.push(...dead.map(fullProp));
  } else if (request.mode === "propname") {
    ok.push(...Object.entries(live).flatMap(([name, value]) => (value === undefined ? [] : [propXml(name, "")])));
    ok.push(...dead.map((property) => emptyProp(property)));
  } else {
    for (const property of request.properties) {
      const liveValue = property.namespaceURI === DAV ? live[property.localName as keyof typeof live] : undefined;
      if (liveValue !== undefined) {
        ok.push(propXml(property.localName, liveValue));
        continue;
      }
      const found = dead.find((item) => item.namespaceURI === property.namespaceURI && item.localName === property.localName);
      if (found) ok.push(fullProp(found));
      else missing.push(emptyProp(property));
    }
  }
  const href = resourceHref(ctx.mountPath, key, isCollection(object, key));
  return `<response><href>${escapeXml(href)}</href>${propstat("HTTP/1.1 200 OK", ok)}${propstat("HTTP/1.1 404 Not Found", missing)}</response>`;
}

function liveProps(object: DavObject | null, key: string, mountPath: string, locks: LockRecord[], now: number): Record<string, string | undefined> {
  const collection = isCollection(object, key);
  const uploaded = object?.uploaded ?? new Date(now);
  return {
    creationdate: uploaded.toISOString().replace(/\.\d{3}Z$/, "Z"),
    displayname: key === "" ? "drive" : key.slice(key.lastIndexOf("/") + 1),
    getcontentlanguage: object?.httpMetadata?.contentLanguage,
    getcontentlength: String(object?.size ?? 0),
    getcontenttype: collection ? undefined : object?.httpMetadata?.contentType,
    getetag: object?.etag,
    getlastmodified: uploaded.toUTCString(),
    resourcetype: collection ? COLLECTION : "",
    supportedlock: supportedLockXml(),
    lockdiscovery: lockDiscovery(locks),
  };
}

const RAW = new Set(["resourcetype", "supportedlock", "lockdiscovery"]);

function propXml(name: string, value: string): string {
  const content = RAW.has(name) ? value : escapeXml(value);
  return `<${name}>${content}</${name}>`;
}

function propstat(status: string, properties: string[]): string {
  if (properties.length === 0) return "";
  return `<propstat><prop>${properties.join("")}</prop><status>${status}</status></propstat>`;
}

function deadOnly(metadata: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!metadata) return out;
  for (const [key, value] of Object.entries(metadata)) if (key.startsWith(DEAD)) out[key] = value;
  if (metadata.resourcetype === COLLECTION) out.resourcetype = COLLECTION;
  return out;
}

function deadProps(metadata: Record<string, string> | undefined): DeadProperty[] {
  if (!metadata) return [];
  return Object.entries(metadata)
    .filter(([key]) => key.startsWith(DEAD))
    .flatMap(([, value]) => {
      try {
        const parsed = JSON.parse(value) as DeadProperty;
        if (!parsed || typeof parsed.localName !== "string") return [];
        return [parsed];
      } catch {
        return [];
      }
    });
}

function deadKey(property: DeadProperty): string {
  return `${DEAD}${encodeURIComponent(property.namespaceURI)}:${encodeURIComponent(property.localName)}`;
}

function metadataSize(metadata: Record<string, string>): number {
  const encoder = new TextEncoder();
  let size = 0;
  for (const [key, value] of Object.entries(metadata)) size += encoder.encode(key).byteLength + encoder.encode(value).byteLength;
  return size;
}

const PROTECTED = new Set([
  "creationdate",
  "displayname",
  "getcontentlanguage",
  "getcontentlength",
  "getcontenttype",
  "getetag",
  "getlastmodified",
  "resourcetype",
  "supportedlock",
  "lockdiscovery",
]);

function protectedProperty(property: DeadProperty): boolean {
  return PROTECTED.has(property.localName);
}

function fullProp(property: DeadProperty): string {
  const name = property.prefix ? `${property.prefix}:${property.localName}` : property.localName;
  const xmlns =
    property.namespaceURI === ""
      ? ' xmlns=""'
      : property.prefix
        ? ` xmlns:${property.prefix}="${escapeXml(property.namespaceURI)}"`
        : ` xmlns="${escapeXml(property.namespaceURI)}"`;
  return `<${name}${xmlns}>${property.valueXml}</${name}>`;
}

function emptyProp(property: DeadProperty): string {
  return fullProp({ ...property, valueXml: "" });
}

function extractOwner(body: string): string | undefined {
  const owner = /<owner(?:\s[^>]*)?>([\s\S]*?)<\/owner>/i.exec(body)?.[1]?.trim();
  return owner ? owner : undefined;
}

function parseXml(body: string): XmlLike | null {
  if (!body.trim()) return null;
  try {
    const errors: string[] = [];
    const document = new DOMParser({
      onError: (level: string, message: string) => {
        if (level !== "warning") errors.push(message);
      },
    }).parseFromString(body, "application/xml");
    if (errors.length > 0 || !document.documentElement) return null;
    return document.documentElement as unknown as XmlLike;
  } catch {
    return null;
  }
}

function children(node: XmlLike): XmlLike[] {
  const out: XmlLike[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) out.push(child);
  }
  return out;
}

function innerXml(node: XmlLike): string {
  let xml = "";
  for (let child = node.firstChild; child; child = child.nextSibling) xml += child.toString();
  return xml;
}

function elementProperty(element: XmlLike): DeadProperty | null {
  if (element.prefix && !element.namespaceURI) return null;
  return {
    namespaceURI: element.namespaceURI ?? "",
    localName: element.localName,
    prefix: element.prefix,
    valueXml: innerXml(element),
  };
}

function parsePropfind(body: string): Propfind | null {
  if (body.trim() === "") return { mode: "allprop" };
  const root = parseXml(body);
  if (!root || root.localName.toLowerCase() !== "propfind") return null;
  const nodes = children(root);
  if (nodes.some((node) => node.localName.toLowerCase() === "propname")) return { mode: "propname" };
  const prop = nodes.find((node) => node.localName.toLowerCase() === "prop");
  if (prop) {
    const properties = children(prop).map(elementProperty);
    if (properties.some((property) => property === null)) return null;
    return { mode: "prop", properties: properties as DeadProperty[] };
  }
  if (nodes.some((node) => node.localName.toLowerCase() === "allprop")) return { mode: "allprop" };
  return null;
}

function parseProppatch(body: string): { action: "set" | "remove"; property: DeadProperty }[] | null {
  const root = parseXml(body);
  if (!root || root.localName.toLowerCase() !== "propertyupdate") return null;
  const operations: { action: "set" | "remove"; property: DeadProperty }[] = [];
  for (const action of children(root)) {
    const name = action.localName.toLowerCase();
    if (name !== "set" && name !== "remove") continue;
    const prop = children(action).find((node) => node.localName.toLowerCase() === "prop");
    if (!prop) continue;
    for (const propertyNode of children(prop)) {
      const property = elementProperty(propertyNode);
      if (!property) return null;
      operations.push({ action: name, property });
    }
  }
  return operations;
}
