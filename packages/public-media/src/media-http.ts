import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { types as nodeTypes } from "node:util";

import type { PawketDatabase } from "@pawket/database";

import { DERIVATIVE_MAX_BYTES, isOpaqueVersionId, isRawStorageEtag } from "./media-policy.js";
import { PublicMediaServiceError, type DeliveryGrant } from "./media-service.js";
import type { CatalogMediaVisibilityPort } from "./media-ports.js";
import type { ObjectStoragePort } from "./object-storage-port.js";
import { readExactOwnRecord } from "./runtime-boundary.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACTOR_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const CONTENT_HASH = /^sha256:v1:[A-Za-z0-9_-]{43}$/u;
const DELIVERABLE_VARIANTS = ["thumb", "display", "large"] as const;
type DeliverableVariant = (typeof DELIVERABLE_VARIANTS)[number];

type MediaDeliveryService = Readonly<{
  getDeliveryGrant(command: Readonly<{ assetId: string; variant: DeliverableVariant }>): Promise<DeliveryGrant>;
}>;

type MediaSession = Readonly<{ userId: string }>;

export type MediaHttpHandlers = Readonly<{
  deliver(request: unknown, assetId: unknown, variant: unknown): Promise<Response>;
}>;

type RequestSnapshot = Readonly<{ method: string; url: string; headers: Headers }>;

type Input = Readonly<{
  db: PawketDatabase;
  media: MediaDeliveryService;
  storage: Pick<ObjectStoragePort, "headObject" | "getObject">;
  catalog: CatalogMediaVisibilityPort;
  authenticate(headers: Headers): Promise<MediaSession | null>;
  onMetric?: (metric: Readonly<{ operation: "delivery"; outcome: "succeeded" | "storage_unavailable" | "not_found" }>) => void;
}>;

const COMMON_HEADERS = {
  "cache-control": "public, no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
};
const REQUEST_METHOD_GETTER = Object.getOwnPropertyDescriptor(Request.prototype, "method")?.get;
const REQUEST_URL_GETTER = Object.getOwnPropertyDescriptor(Request.prototype, "url")?.get;
const REQUEST_HEADERS_GETTER = Object.getOwnPropertyDescriptor(Request.prototype, "headers")?.get;

function notFound(input: Input): Response {
  metric(input, "not_found");
  return new Response(null, { status: 404, headers: COMMON_HEADERS });
}

function unavailable(input: Input, headOnly = false): Response {
  metric(input, "storage_unavailable");
  return new Response(headOnly ? null : JSON.stringify({ code: "MEDIA_UNAVAILABLE" }), {
    status: 503,
    headers: { ...COMMON_HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}

function metric(input: Input, outcome: "succeeded" | "storage_unavailable" | "not_found"): void {
  try { input.onMetric?.({ operation: "delivery", outcome }); }
  catch { /* Telemetry cannot alter delivery. */ }
}

function isDeliverableVariant(value: unknown): value is DeliverableVariant {
  return typeof value === "string" && (DELIVERABLE_VARIANTS as readonly string[]).includes(value);
}

function snapshotRequest(value: unknown): RequestSnapshot | null {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value)) return null;
  try {
    if (
      Object.getPrototypeOf(value) !== Request.prototype ||
      Reflect.ownKeys(value).some((key) => typeof key === "string") ||
      typeof REQUEST_METHOD_GETTER !== "function" ||
      typeof REQUEST_URL_GETTER !== "function" ||
      typeof REQUEST_HEADERS_GETTER !== "function"
    ) return null;
    const method = Reflect.apply(REQUEST_METHOD_GETTER, value, []);
    const url = Reflect.apply(REQUEST_URL_GETTER, value, []);
    const headers = Reflect.apply(REQUEST_HEADERS_GETTER, value, []);
    if (
      typeof method !== "string" ||
      typeof url !== "string" ||
      !headers || typeof headers !== "object" || nodeTypes.isProxy(headers) ||
      Object.getPrototypeOf(headers) !== Headers.prototype
    ) return null;
    return { method, url, headers: new Headers(headers) };
  } catch {
    return null;
  }
}

function previewRequested(url: string): boolean {
  try {
    const parameters = [...new URL(url).searchParams.entries()];
    return parameters.length === 1 && parameters[0]![0] === "preview" && parameters[0]![1] === "1";
  } catch {
    return false;
  }
}

function exactSession(value: unknown): MediaSession | null {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "userId");
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" || !ACTOR_ID.test(descriptor.value)) return null;
    return { userId: descriptor.value };
  } catch {
    return null;
  }
}

function exactGrant(value: unknown, assetId: string, variant: DeliverableVariant): DeliveryGrant | null {
  const grant = readExactOwnRecord(value, ["location", "contentLength", "contentType", "contentHash"]);
  if (!grant || grant.contentType !== "image/webp" || !Number.isSafeInteger(grant.contentLength) || (grant.contentLength as number) < 1 || (grant.contentLength as number) > DERIVATIVE_MAX_BYTES[variant] || typeof grant.contentHash !== "string" || !CONTENT_HASH.test(grant.contentHash)) return null;
  const location = readExactOwnRecord(grant.location, ["area", "key", "versionId"]);
  if (!location || location.area !== "derivative" || typeof location.key !== "string" || !location.key.startsWith(`derivatives/${assetId}/${variant}/`) || !location.key.endsWith(".webp") || !isOpaqueVersionId(location.versionId)) return null;
  return {
    location: { area: "derivative", key: location.key, versionId: location.versionId },
    contentLength: grant.contentLength as number,
    contentType: "image/webp",
    contentHash: grant.contentHash,
  };
}

function exactHead(value: unknown, grant: DeliveryGrant): boolean {
  const head = readExactOwnRecord(value, ["contentLength", "contentType", "etag", "versionId", "sha256"]);
  return Boolean(
    head &&
    head.contentLength === grant.contentLength &&
    head.contentType === "image/webp" &&
    isRawStorageEtag(head.etag) &&
    head.versionId === grant.location.versionId &&
    head.sha256 === grant.contentHash,
  );
}

async function closeBody(body: Readable): Promise<void> {
  try {
    Reflect.apply(Readable.prototype.destroy, body, []);
    return;
  } catch { /* best effort */ }
  try {
    const iterator = (body as AsyncIterable<unknown>)[Symbol.asyncIterator]?.();
    await iterator?.return?.();
  } catch { /* best effort */ }
}

function streamExactBody(input: Input, body: unknown, grant: DeliveryGrant): ReadableStream<Uint8Array> | null {
  if (!body || typeof body !== "object" || nodeTypes.isProxy(body) || !(body instanceof Readable)) return null;
  let reader: ReadableStreamDefaultReader<unknown>;
  try { reader = Readable.toWeb(body).getReader() as ReadableStreamDefaultReader<unknown>; }
  catch { void closeBody(body); return null; }
  let total = 0;
  let settled = false;
  const digest = createHash("sha256");
  const finish = (outcome: "succeeded" | "storage_unavailable"): void => {
    if (settled) return;
    settled = true;
    metric(input, outcome);
  };
  const fail = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
    finish("storage_unavailable");
    await closeBody(body);
    try { await reader.cancel(); } catch { /* source may already be errored */ }
    controller.error(new Error("MEDIA_STREAM_UNAVAILABLE"));
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          if (
            total !== grant.contentLength ||
            `sha256:v1:${digest.digest("base64url")}` !== grant.contentHash
          ) {
            await fail(controller);
            return;
          }
          finish("succeeded");
          controller.close();
          return;
        }
        if (!(next.value instanceof Uint8Array) || nodeTypes.isProxy(next.value)) {
          await fail(controller);
          return;
        }
        const chunk = Uint8Array.from(next.value);
        total += chunk.byteLength;
        if (total > grant.contentLength) {
          await fail(controller);
          return;
        }
        digest.update(chunk);
        controller.enqueue(chunk);
      } catch {
        await fail(controller);
      }
    },
    async cancel() {
      finish("storage_unavailable");
      await closeBody(body);
      try { await reader.cancel(); } catch { /* best effort */ }
    },
  });
}

export function createMediaHttpHandlers(input: Input): MediaHttpHandlers {
  async function deliver(requestValue: unknown, assetIdValue: unknown, variantValue: unknown): Promise<Response> {
    const request = snapshotRequest(requestValue);
    if (!request) return notFound(input);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { ...COMMON_HEADERS, allow: "GET, HEAD" } });
    }
    if (typeof assetIdValue !== "string" || typeof variantValue !== "string") return notFound(input);
    const assetId = assetIdValue;
    const variant = variantValue;
    if (!UUID.test(assetId) || !isDeliverableVariant(variant)) return notFound(input);

    try {
      if (previewRequested(request.url)) {
        const session = exactSession(await input.authenticate(request.headers));
        if (!session || await input.catalog.isDerivativePreviewable(input.db, session.userId, assetId, variant) !== true) return notFound(input);
      } else if (await input.catalog.isDerivativePublic(input.db, assetId, variant) !== true) {
        return notFound(input);
      }
    } catch {
      return notFound(input);
    }

    let grant: DeliveryGrant;
    try {
      const candidate = exactGrant(await input.media.getDeliveryGrant({ assetId, variant }), assetId, variant);
      if (!candidate) return unavailable(input, request.method === "HEAD");
      grant = candidate;
    } catch (error) {
      if (error instanceof PublicMediaServiceError && (error.code === "MEDIA_NOT_FOUND" || error.code === "MEDIA_NOT_READY" || error.code === "INVALID_INPUT")) return notFound(input);
      return unavailable(input, request.method === "HEAD");
    }

    try {
      if (!exactHead(await input.storage.headObject(grant.location), grant)) return unavailable(input, request.method === "HEAD");
      const headers = {
        ...COMMON_HEADERS,
        "content-type": "image/webp",
        "content-length": String(grant.contentLength),
      };
      if (request.method === "HEAD") {
        metric(input, "succeeded");
        return new Response(null, { status: 200, headers });
      }
      const body = await input.storage.getObject(grant.location);
      const safeBody = streamExactBody(input, body, grant);
      if (!safeBody) return unavailable(input);
      return new Response(safeBody, { status: 200, headers });
    } catch {
      return unavailable(input, request.method === "HEAD");
    }
  }

  return { deliver };
}
