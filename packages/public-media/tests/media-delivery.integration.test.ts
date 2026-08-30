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
const contentHash = `sha256:v1:${"a".repeat(43)}`;
const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46]);

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

function expectSafeHeaders(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("public, no-store");
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

  test("authorizes private preview only for an authenticated owning active creator and exact draft reference", async () => {
    const { handlers, calls } = fixture();
    const response = await handlers.deliver(
      new Request(`https://pawket.test/media/${assetId}/thumb?preview=1`, {
        headers: { authorization: "Bearer private-session" },
      }),
      assetId,
      "thumb",
    );
    expect(response.status).toBe(200);
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
      new Request(`https://pawket.test/media/${assetId}/large?preview=1`),
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
  ])("closes %s before returning media bytes and destroys the source", async (_scenario, createBody) => {
    const body = createBody();
    const destroy = vi.spyOn(body, "destroy");
    const { handlers, calls } = fixture({
      storage: {
        headObject: vi.fn(async () => ({ contentLength: bytes.byteLength, contentType: "image/webp", etag: "etag", versionId: location.versionId, sha256: contentHash })),
        getObject: vi.fn(async () => body),
      },
    });
    const response = await handlers.deliver(new Request(`https://pawket.test/media/${assetId}/display`), assetId, "display");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "MEDIA_UNAVAILABLE" });
    expect(calls.metric).toHaveBeenCalledWith({ operation: "delivery", outcome: "storage_unavailable" });
    expect(destroy).toHaveBeenCalled();
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
});
