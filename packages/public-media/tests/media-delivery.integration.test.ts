import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { describe, expect, test, vi } from "vitest";

import { createMediaHttpHandlers } from "../src/media-http.js";
import { PublicMediaServiceError } from "../src/media-service.js";

const assetId = "00000000-0000-4000-8000-000000000101";
const location = {
  area: "derivative" as const,
  key: `derivatives/${assetId}/display/safe-hash.webp`,
  versionId: "opaque-version-1",
};
const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46]);
const contentHash = `sha256:v1:${createHash("sha256").update(bytes).digest("base64url")}`;

function fixture(overrides: Record<string, unknown> = {}) {
  const calls = {
    publicVisibility: vi.fn(async () => true),
    previewVisibility: vi.fn(async () => true),
    authenticate: vi.fn(async () => ({ userId: "creator-001" })),
    getDeliveryGrant: vi.fn(async (command: { assetId: string; variant: "thumb" | "display" | "large" }) => ({
      location: { ...location, key: `derivatives/${command.assetId}/${command.variant}/safe-hash.webp` },
      contentLength: bytes.byteLength,
      contentType: "image/webp" as const,
      contentHash,
    })),
    headObject: vi.fn(async (requested: typeof location) => ({
      contentLength: bytes.byteLength,
      contentType: "image/webp",
      etag: "opaque-etag-1",
      versionId: requested.versionId,
      sha256: contentHash,
    })),
    getObject: vi.fn(async () => Readable.from([bytes])),
    metric: vi.fn(),
  };
  const handlers = createMediaHttpHandlers({
    db: { marker: "database" } as never,
    media: { getDeliveryGrant: calls.getDeliveryGrant },
    storage: {
      headObject: calls.headObject,
      getObject: calls.getObject,
    } as never,
    catalog: {
      isDerivativePublic: calls.publicVisibility,
      isDerivativePreviewable: calls.previewVisibility,
    },
    authenticate: calls.authenticate,
    onMetric: calls.metric,
    ...overrides,
  } as never);
  return { handlers, calls };
}

async function responseBytes(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

function expectSafeHeaders(response: Response, cacheControl = "public, no-store"): void {
  expect(response.headers.get("cache-control")).toBe(cacheControl);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
}

async function unavailablePreview(): Promise<boolean> {
  return false;
}

describe("public media delivery", () => {
  test("streams only an exact ready private derivative after a fresh public visibility read", async () => {
    const { handlers, calls } = fixture();
    const response = await handlers.deliver(
      new Request(`https://pawket.test/media/${assetId}/display`, { method: "GET" }),
      assetId,
      "display",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
    expectSafeHeaders(response);
    expect(await responseBytes(response)).toEqual(bytes);
    expect(calls.publicVisibility).toHaveBeenCalledOnce();
    expect(calls.publicVisibility.mock.calls[0]?.slice(1)).toEqual([assetId, "display"]);
    expect(calls.getDeliveryGrant).toHaveBeenCalledWith({ assetId, variant: "display" });
    expect(calls.headObject).toHaveBeenCalledWith(location);
    expect(calls.getObject).toHaveBeenCalledWith(location);
    expect(calls.previewVisibility).not.toHaveBeenCalled();
    expect(calls.authenticate).not.toHaveBeenCalled();
    expect(calls.metric).toHaveBeenCalledWith({ operation: "delivery", outcome: "succeeded" });
  });

  test("returns the authorized response before the full derivative has arrived", async () => {
    let release!: () => void;
    const continueStream = new Promise<void>((resolve) => { release = resolve; });
    const body = Readable.from((async function* () {
      yield bytes.subarray(0, 1);
      await continueStream;
      yield bytes.subarray(1);
    })());
    const { handlers } = fixture({
      storage: {
        headObject: vi.fn(async () => ({ contentLength: bytes.byteLength, contentType: "image/webp", etag: "etag", versionId: location.versionId, sha256: contentHash })),
        getObject: vi.fn(async () => body),
      },
    });
    const responsePromise = handlers.deliver(new Request(`https://pawket.test/media/${assetId}/display`), assetId, "display");
    const settled = await Promise.race([
      responsePromise.then(() => true),
      new Promise<false>((resolve) => { setTimeout(() => resolve(false), 75); }),
    ]);
    release();
    const response = await responsePromise;
    expect(settled).toBe(true);
    expect(response.status).toBe(200);
    expect(await responseBytes(response)).toEqual(bytes);
  });

  test.each(["unknown", "draft-only", "unpublished", "page-held", "showcase-held", "suspended"])(
    "makes %s indistinguishable from neutral not found",
    async () => {
      const { handlers, calls } = fixture({
        catalog: {
          isDerivativePublic: vi.fn(async () => false),
          isDerivativePreviewable: unavailablePreview,
        },
      });
      const response = await handlers.deliver(
        new Request(`https://pawket.test/media/${assetId}/display`),
        assetId,
        "display",
      );
      expect(response.status).toBe(404);
      expectSafeHeaders(response);
      expect(await response.text()).toBe("");
      expect(calls.getDeliveryGrant).not.toHaveBeenCalled();
      expect(calls.headObject).not.toHaveBeenCalled();
      expect(calls.getObject).not.toHaveBeenCalled();
    },
  );

  test("returns public master and malformed identifiers before any database or provider call", async () => {
    const { handlers, calls } = fixture();
    for (const [candidateAssetId, variant] of [
      [assetId, "master"],
      ["not-a-uuid", "display"],
      [assetId, "original"],
    ] as const) {
      const response = await handlers.deliver(
        new Request(`https://pawket.test/media/${candidateAssetId}/${variant}`),
        candidateAssetId,
        variant,
      );
      expect(response.status).toBe(404);
      expectSafeHeaders(response);
    }
    expect(calls.publicVisibility).not.toHaveBeenCalled();
    expect(calls.previewVisibility).not.toHaveBeenCalled();
    expect(calls.authenticate).not.toHaveBeenCalled();
    expect(calls.getDeliveryGrant).not.toHaveBeenCalled();
    expect(calls.headObject).not.toHaveBeenCalled();
    expect(calls.getObject).not.toHaveBeenCalled();
  });

  test.each(["GET", "HEAD"] as const)("marks an authorized private preview %s response private and non-cacheable", async (method) => {
    const { handlers, calls } = fixture();
    const response = await handlers.deliver(
      new Request(`https://pawket.test/media/${assetId}/thumb?preview=1`, {
        method,
        headers: { authorization: "Bearer private-session" },
      }),
      assetId,
      "thumb",
    );
    expect(response.status).toBe(200);
    expectSafeHeaders(response, "private, no-store");
    if (method === "HEAD") {
      expect(response.body).toBeNull();
      expect(calls.getObject).not.toHaveBeenCalled();
    } else {
      expect(await responseBytes(response)).toEqual(bytes);
    }
    expect(calls.authenticate).toHaveBeenCalledOnce();
    expect(calls.previewVisibility).toHaveBeenCalledOnce();
    expect(calls.previewVisibility.mock.calls[0]?.slice(1)).toEqual(["creator-001", assetId, "thumb"]);
    expect(calls.publicVisibility).not.toHaveBeenCalled();
  });

  test.each([
    ["unauthenticated", null, true],
    ["foreign-or-inactive", { userId: "creator-001" }, false],
  ] as const)("closes %s private preview as neutral not found", async (_scenario, actor, previewable) => {
    const authenticate = vi.fn(async () => actor);
    const previewVisibility = vi.fn(async () => previewable);
    const { handlers, calls } = fixture({
      authenticate,
      catalog: { isDerivativePublic: vi.fn(async () => true), isDerivativePreviewable: previewVisibility },
    });
    const response = await handlers.deliver(
      new Request(`https://pawket.test/media/${assetId}/large?preview=1`, {
        headers: { authorization: "Bearer neutral-preview" },
      }),
      assetId,
      "large",
    );
    expect(response.status).toBe(404);
    expectSafeHeaders(response);
    expect(calls.getDeliveryGrant).not.toHaveBeenCalled();
    expect(calls.getObject).not.toHaveBeenCalled();
  });

  test("HEAD verifies exact storage evidence without opening the response body", async () => {
    const { handlers, calls } = fixture();
    const response = await handlers.deliver(
      new Request(`https://pawket.test/media/${assetId}/display`, { method: "HEAD" }),
      assetId,
      "display",
    );
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(calls.headObject).toHaveBeenCalledOnce();
    expect(calls.getObject).not.toHaveBeenCalled();
  });

  test("allows GET and HEAD only", async () => {
    const { handlers, calls } = fixture();
    const response = await handlers.deliver(
      new Request(`https://pawket.test/media/${assetId}/display`, { method: "POST" }),
      assetId,
      "display",
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expectSafeHeaders(response);
    expect(calls.publicVisibility).not.toHaveBeenCalled();
    expect(calls.getDeliveryGrant).not.toHaveBeenCalled();
  });

  test.each([
    ["missing HEAD", null],
    ["wrong exact version", { contentLength: bytes.byteLength, contentType: "image/webp", etag: "etag", versionId: "wrong-version", sha256: contentHash }],
    ["wrong length", { contentLength: bytes.byteLength + 1, contentType: "image/webp", etag: "etag", versionId: location.versionId, sha256: contentHash }],
    ["wrong MIME", { contentLength: bytes.byteLength, contentType: "image/png", etag: "etag", versionId: location.versionId, sha256: contentHash }],
    ["wrong hash", { contentLength: bytes.byteLength, contentType: "image/webp", etag: "etag", versionId: location.versionId, sha256: `sha256:v1:${"b".repeat(43)}` }],
    ["malformed ETag", { contentLength: bytes.byteLength, contentType: "image/webp", etag: " null ", versionId: location.versionId, sha256: contentHash }],
  ])("maps authorized %s evidence to bounded 503", async (_scenario, evidence) => {
    const headObject = vi.fn(async () => evidence);
    const { handlers, calls } = fixture({ storage: { headObject, getObject: vi.fn() } });
    const response = await handlers.deliver(
      new Request(`https://pawket.test/media/${assetId}/display`, { method: "HEAD" }),
      assetId,
      "display",
    );
    expect(response.status).toBe(503);
    expectSafeHeaders(response);
    expect(await response.text()).toBe("");
    expect(JSON.stringify(calls.metric.mock.calls)).not.toMatch(/derivatives|opaque|creator/i);
    expect(calls.metric).toHaveBeenCalledWith({ operation: "delivery", outcome: "storage_unavailable" });
  });

  test.each([
    ["truncated body", () => Readable.from([bytes.subarray(0, 2)])],
    ["oversized body", () => Readable.from([bytes, Buffer.from([0])])],
    ["stream failure", () => Readable.from((async function* () { yield bytes.subarray(0, 1); throw new Error("provider key secret"); })())],
    ["content hash mismatch", () => Readable.from([Buffer.from([0, 1, 2, 3])])],
  ])("surfaces %s as a closed body-stream failure after committing safe headers", async (_scenario, createBody) => {
    const body = createBody();
    const { handlers, calls } = fixture({
      storage: {
        headObject: vi.fn(async () => ({ contentLength: bytes.byteLength, contentType: "image/webp", etag: "etag", versionId: location.versionId, sha256: contentHash })),
        getObject: vi.fn(async () => body),
      },
    });
    const response = await handlers.deliver(new Request(`https://pawket.test/media/${assetId}/display`), assetId, "display");
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow("MEDIA_STREAM_UNAVAILABLE");
    expect(calls.metric).toHaveBeenCalledWith({ operation: "delivery", outcome: "storage_unavailable" });
    expect(body.destroyed).toBe(true);
  });

  test("closes the storage stream and records one bounded failure when the client cancels", async () => {
    let emitted = false;
    const body = new Readable({
      read() {
        if (emitted) return;
        emitted = true;
        this.push(bytes.subarray(0, 1));
      },
    });
    const { handlers, calls } = fixture({
      storage: {
        headObject: vi.fn(async () => ({ contentLength: bytes.byteLength, contentType: "image/webp", etag: "etag", versionId: location.versionId, sha256: contentHash })),
        getObject: vi.fn(async () => body),
      },
    });
    const response = await handlers.deliver(new Request(`https://pawket.test/media/${assetId}/display`), assetId, "display");
    const reader = response.body!.getReader();

    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(Array.from(first.value ?? [])).toEqual(Array.from(bytes.subarray(0, 1)));
    await reader.cancel();

    expect(body.destroyed).toBe(true);
    expect(calls.metric).toHaveBeenCalledTimes(1);
    expect(calls.metric).toHaveBeenCalledWith({ operation: "delivery", outcome: "storage_unavailable" });
  });

  test("rejects hostile request and identifier shapes without invoking traps or ports", async () => {
    const { handlers, calls } = fixture();
    let traps = 0;
    const proxiedRequest = new Proxy(new Request(`https://pawket.test/media/${assetId}/display`), {
      get() { traps += 1; throw new Error("request trap"); },
    });
    class HostileRequest extends Request {}
    Object.defineProperty(HostileRequest.prototype, "method", { get() { traps += 1; throw new Error("subclass trap"); } });
    const accessorRequest = new Request(`https://pawket.test/media/${assetId}/display`);
    Object.defineProperty(accessorRequest, "method", { get() { traps += 1; throw new Error("accessor trap"); } });
    const coerciveAssetId = new Proxy({}, { get() { traps += 1; throw new Error("asset trap"); } });
    const coerciveVariant = new Proxy({}, { get() { traps += 1; throw new Error("variant trap"); } });

    for (const [request, candidateAssetId, variant] of [
      [proxiedRequest, assetId, "display"],
      [new HostileRequest(`https://pawket.test/media/${assetId}/display`), assetId, "display"],
      [accessorRequest, assetId, "display"],
      [new Request(`https://pawket.test/media/${assetId}/display`), coerciveAssetId, "display"],
      [new Request(`https://pawket.test/media/${assetId}/display`), assetId, coerciveVariant],
    ] as const) {
      const response = await handlers.deliver(request as never, candidateAssetId as never, variant as never);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    }
    expect(traps).toBe(0);
    expect(calls.publicVisibility).not.toHaveBeenCalled();
    expect(calls.getDeliveryGrant).not.toHaveBeenCalled();
    expect(calls.headObject).not.toHaveBeenCalled();
    expect(calls.getObject).not.toHaveBeenCalled();
  });

  test("snapshots native request headers without invoking hostile own iterator or method traps", async () => {
    const traps: PropertyKey[] = [];
    const request = new Request(`https://pawket.test/media/${assetId}/thumb?preview=1`, {
      headers: { authorization: "Bearer private-session" },
    });
    const hostileHeaders = request.headers;
    for (const key of [Symbol.iterator, "entries", "forEach"] as const) {
      Object.defineProperty(hostileHeaders, key, {
        configurable: true,
        get() {
          traps.push(key);
          throw new Error("headers trap secret");
        },
      });
    }
    let receivedHeaders: Headers | undefined;
    const authenticate = vi.fn(async (headers: Headers) => {
      receivedHeaders = headers;
      expect(Object.getPrototypeOf(headers)).toBe(Headers.prototype);
      expect(headers.get("authorization")).toBe("Bearer private-session");
      return { userId: "creator-001" };
    });
    const { handlers } = fixture({ authenticate });

    const response = await handlers.deliver(request, assetId, "thumb");

    expect(traps).toEqual([]);
    expect(authenticate).toHaveBeenCalledOnce();
    expect(Object.is(receivedHeaders, hostileHeaders)).toBe(false);
    expect(response.status).toBe(200);
    expect(await responseBytes(response)).toEqual(bytes);
  });

  test("rejects an oversized typed-array chunk before any Uint8Array.from copy", async () => {
    const oversized = new Uint8Array(bytes.byteLength + 1);
    const copy = vi.spyOn(Uint8Array, "from");
    const body = Readable.from([oversized]);
    const { handlers } = fixture({
      storage: {
        headObject: vi.fn(async () => ({ contentLength: bytes.byteLength, contentType: "image/webp", etag: "etag", versionId: location.versionId, sha256: contentHash })),
        getObject: vi.fn(async () => body),
      },
    });

    const response = await handlers.deliver(new Request(`https://pawket.test/media/${assetId}/display`), assetId, "display");

    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow("MEDIA_STREAM_UNAVAILABLE");
    expect(copy).not.toHaveBeenCalled();
    copy.mockRestore();
  });

  test.each(["subclass", "shared-buffer"] as const)("rejects a %s stream chunk before copying", async (scenario) => {
    class HostileChunk extends Uint8Array {}
    const chunk = scenario === "subclass"
      ? new HostileChunk(bytes.byteLength)
      : new Uint8Array(new SharedArrayBuffer(bytes.byteLength));
    const copy = vi.spyOn(Uint8Array, "from");
    const body = Readable.from((async function* () { yield chunk; })());
    const { handlers } = fixture({
      storage: {
        headObject: vi.fn(async () => ({ contentLength: bytes.byteLength, contentType: "image/webp", etag: "etag", versionId: location.versionId, sha256: contentHash })),
        getObject: vi.fn(async () => body),
      },
    });

    const response = await handlers.deliver(new Request(`https://pawket.test/media/${assetId}/display`), assetId, "display");

    await expect(response.arrayBuffer()).rejects.toThrow("MEDIA_STREAM_UNAVAILABLE");
    expect(copy).not.toHaveBeenCalled();
    copy.mockRestore();
  });

  test("maps ready-row and provider errors without exposing storage facts", async () => {
    const secret = "derivatives/private/key opaque-version creator-001";
    const { handlers, calls } = fixture({
      media: { getDeliveryGrant: vi.fn(async () => { throw new PublicMediaServiceError("MEDIA_NOT_READY"); }) },
    });
    const notReady = await handlers.deliver(new Request(`https://pawket.test/media/${assetId}/display`), assetId, "display");
    expect(notReady.status).toBe(404);

    const outageFixture = fixture({
      storage: {
        headObject: vi.fn(async () => { throw new Error(secret); }),
        getObject: vi.fn(),
      },
    });
    const unavailable = await outageFixture.handlers.deliver(new Request(`https://pawket.test/media/${assetId}/display`), assetId, "display");
    const serialized = `${await unavailable.text()} ${JSON.stringify(outageFixture.calls.metric.mock.calls)}`;
    expect(unavailable.status).toBe(503);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toMatch(/derivatives|opaque-version|creator-001/u);
    expect(calls.getObject).not.toHaveBeenCalled();
  });

  test("maps hostile unknown errors without prototype traps or provider text", async () => {
    let traps = 0;
    const hostile = new Proxy(new PublicMediaServiceError("MEDIA_NOT_READY"), {
      getPrototypeOf() {
        traps += 1;
        throw new Error("provider prototype secret");
      },
      get() {
        traps += 1;
        throw new Error("provider getter secret");
      },
    });
    const { handlers, calls } = fixture({
      media: { getDeliveryGrant: vi.fn(async () => { throw hostile; }) },
    });

    const response = await handlers.deliver(new Request(`https://pawket.test/media/${assetId}/display`), assetId, "display");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "MEDIA_UNAVAILABLE" });
    expect(traps).toBe(0);
    expect(JSON.stringify(calls.metric.mock.calls)).not.toMatch(/provider|prototype|getter|secret/u);
  });
});
