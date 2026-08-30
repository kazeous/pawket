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
const NATIVE_HEADERS = Headers;
const HEADERS_ENTRIES = Headers.prototype.entries;
const HEADERS_ITERATOR_NEXT = (() => {
  try {
    const iterator = Reflect.apply(HEADERS_ENTRIES, new NATIVE_HEADERS(), []) as object;
    return Object.getPrototypeOf(iterator)?.next as unknown;
  } catch {
    return undefined;
  }
})();
const PUBLIC_MEDIA_SERVICE_ERROR_PROTOTYPE = PublicMediaServiceError.prototype;
const NATIVE_UINT8_ARRAY = Uint8Array;
const UINT8_ARRAY_PROTOTYPE = Uint8Array.prototype;
const NATIVE_BUFFER_PROTOTYPE = Buffer.prototype;
const NATIVE_ARRAY_BUFFER_PROTOTYPE = ArrayBuffer.prototype;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const TYPED_ARRAY_SET = Uint8Array.prototype.set;

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
    if (typeof HEADERS_ENTRIES !== "function" || typeof HEADERS_ITERATOR_NEXT !== "function") return null;
    const pairs: Array<[string, string]> = [];
    const iterator = Reflect.apply(HEADERS_ENTRIES, headers, []) as object;
    while (true) {
      const step = Reflect.apply(HEADERS_ITERATOR_NEXT, iterator, []) as unknown;
      const record = readExactOwnRecord(step, ["value", "done"]);
      if (!record || typeof record.done !== "boolean") return null;
      if (record.done) break;
      if (!Array.isArray(record.value) || record.value.length !== 2 || typeof record.value[0] !== "string" || typeof record.value[1] !== "string") return null;
      pairs.push([record.value[0], record.value[1]]);
    }
    return { method, url, headers: new NATIVE_HEADERS(pairs) };
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

function knownServiceNotFoundCode(error: unknown): boolean {
  if (!error || typeof error !== "object" || nodeTypes.isProxy(error)) return false;
  try {
    if (Object.getPrototypeOf(error) !== PUBLIC_MEDIA_SERVICE_ERROR_PROTOTYPE) return false;
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") return false;
    return descriptor.value === "MEDIA_NOT_FOUND" || descriptor.value === "MEDIA_NOT_READY" || descriptor.value === "INVALID_INPUT";
  } catch {
    return false;
  }
}

function copyBoundedChunk(value: unknown, remaining: number): Uint8Array | null {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value)) return null;
  if (typeof TYPED_ARRAY_BYTE_LENGTH_GETTER !== "function" || typeof TYPED_ARRAY_BUFFER_GETTER !== "function") return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== UINT8_ARRAY_PROTOTYPE && prototype !== NATIVE_BUFFER_PROTOTYPE) return null;
    const byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []);
    const buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, value, []);
    if (
      typeof byteLength !== "number" ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      byteLength > remaining ||
      !buffer ||
      typeof buffer !== "object" ||
      nodeTypes.isProxy(buffer) ||
      Object.getPrototypeOf(buffer) !== NATIVE_ARRAY_BUFFER_PROTOTYPE
    ) return null;
    const copy = new NATIVE_UINT8_ARRAY(byteLength);
    Reflect.apply(TYPED_ARRAY_SET, copy, [value]);
    return copy;
  } catch {
    return null;
  }
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
        const chunk = copyBoundedChunk(next.value, grant.contentLength - total);
        if (!chunk) {
          await fail(controller);
          return;
        }
        total += chunk.byteLength;
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
      if (knownServiceNotFoundCode(error)) return notFound(input);
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
