import { randomUUID } from "node:crypto";

import { NoSuchKey, NotFound, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createS3ObjectStorage } from "../src/s3-object-storage.js";

const options = {
  endpoint: "https://objects.example.test",
  region: "test-region-1",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
  quarantineBucket: "test-quarantine",
  derivativeBucket: "test-derivatives",
  forcePathStyle: true,
} as const;

function quarantineKey(): string {
  return `quarantine/${randomUUID()}/${randomUUID()}`;
}

function mockSend(result: unknown) {
  return vi.spyOn(S3Client.prototype, "send").mockResolvedValue(result as never);
}

describe("S3 response runtime boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  test.each([" image/png ", "IMAGE/PNG", "image/png; charset=binary"])("rejects noncanonical presign MIME %s", async (contentType) => {
    const storage = createS3ObjectStorage(options);

    await expect(storage.presignPut({ key: quarantineKey(), contentType, contentLength: 3, expiresInSeconds: 900 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  test("preserves exact bounded HEAD evidence and opaque provider version IDs", async () => {
    const versionId = "opaque:percent%@bang!(parentheses)/+=._~-作品";
    const etag = '"etag:opaque%value"';
    const hash = `sha256:v1:${"a".repeat(43)}`;
    const send = mockSend({
      ContentLength: 3,
      ContentType: "image/png",
      ETag: etag,
      VersionId: versionId,
      Metadata: { sha256: hash },
    });
    const storage = createS3ObjectStorage(options);
    const key = quarantineKey();

    await expect(storage.headObject({ area: "quarantine", key, versionId })).resolves.toEqual({
      contentLength: 3,
      contentType: "image/png",
      etag,
      versionId,
      sha256: hash,
    });
    expect(send).toHaveBeenCalledOnce();
  });

  test.each([
    ["padded content type", { ContentLength: 3, ContentType: " image/png ", ETag: '"etag"', VersionId: "version-1" }],
    ["case-folded content type", { ContentLength: 3, ContentType: "IMAGE/PNG", ETag: '"etag"', VersionId: "version-1" }],
    ["padded ETag", { ContentLength: 3, ContentType: "image/png", ETag: ' "etag" ', VersionId: "version-1" }],
  ])("fails unavailable for malformed raw HEAD evidence: %s", async (_case, result) => {
    mockSend(result);
    const storage = createS3ObjectStorage(options);

    await expect(storage.headObject({ area: "quarantine", key: quarantineKey() })).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
  });

  test("preserves opaque list IDs and rejects malformed pagination without partial output", async () => {
    const key = quarantineKey();
    const versionId = "opaque:percent%@bang!(parentheses)/+=._~-作品";
    const send = mockSend({
      IsTruncated: false,
      Versions: [{ Key: key, VersionId: versionId }],
      DeleteMarkers: [],
    });
    const storage = createS3ObjectStorage(options);

    await expect(storage.listObjectVersions({ area: "quarantine", key })).resolves.toEqual([
      { versionId, isDeleteMarker: false },
    ]);

    send.mockResolvedValueOnce({
      IsTruncated: true,
      Versions: [{ Key: key, VersionId: versionId }],
      DeleteMarkers: [],
      NextKeyMarker: " next-key ",
      NextVersionIdMarker: "next-version",
    } as never);
    await expect(storage.listObjectVersions({ area: "quarantine", key })).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });

    send.mockResolvedValueOnce({
      IsTruncated: false,
      Versions: [{ Key: key, VersionId: "bad\nversion" }],
      DeleteMarkers: [],
    } as never);
    await expect(storage.listObjectVersions({ area: "quarantine", key })).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
  });

  test("rejects an alternating pagination-marker cycle before issuing a fourth request", async () => {
    const key = quarantineKey();
    const send = vi.spyOn(S3Client.prototype, "send")
      .mockResolvedValueOnce({
        IsTruncated: true,
        Versions: [{ Key: key, VersionId: "version-1" }],
        DeleteMarkers: [],
        NextKeyMarker: key,
        NextVersionIdMarker: "marker-a",
      } as never)
      .mockResolvedValueOnce({
        IsTruncated: true,
        Versions: [{ Key: key, VersionId: "version-2" }],
        DeleteMarkers: [],
        NextKeyMarker: key,
        NextVersionIdMarker: "marker-b",
      } as never)
      .mockResolvedValueOnce({
        IsTruncated: true,
        Versions: [{ Key: key, VersionId: "version-3" }],
        DeleteMarkers: [],
        NextKeyMarker: key,
        NextVersionIdMarker: "marker-a",
      } as never);
    const storage = createS3ObjectStorage(options);

    await expect(storage.listObjectVersions({ area: "quarantine", key })).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
    expect(send).toHaveBeenCalledTimes(3);
  });

  test("returns an exact complete result across ordinary version pages", async () => {
    const key = quarantineKey();
    const send = vi.spyOn(S3Client.prototype, "send")
      .mockResolvedValueOnce({
        IsTruncated: true,
        Versions: [{ Key: key, VersionId: "version-1" }],
        DeleteMarkers: [],
        NextKeyMarker: key,
        NextVersionIdMarker: "marker-1",
      } as never)
      .mockResolvedValueOnce({
        IsTruncated: false,
        Versions: [{ Key: key, VersionId: "version-2" }],
        DeleteMarkers: [{ Key: key, VersionId: "delete-marker-1" }],
      } as never);
    const storage = createS3ObjectStorage(options);

    await expect(storage.listObjectVersions({ area: "quarantine", key })).resolves.toEqual([
      { versionId: "version-1", isDeleteMarker: false },
      { versionId: "version-2", isDeleteMarker: false },
      { versionId: "delete-marker-1", isDeleteMarker: true },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  test.each([
    new NoSuchKey({ $metadata: { httpStatusCode: 404 }, message: "missing key" }),
    new NotFound({ $metadata: { httpStatusCode: 404 }, message: "missing object" }),
  ])("maps realistic AWS 404 errors to absence without inspecting prototype getters", async (providerError) => {
    vi.spyOn(S3Client.prototype, "send").mockRejectedValue(providerError);
    const storage = createS3ObjectStorage(options);

    await expect(storage.headObject({ area: "quarantine", key: quarantineKey() })).resolves.toBeNull();
  });

  test("maps a safely wrapped AWS NoSuchVersion error to not found", async () => {
    const providerError = new S3ServiceException({
      $fault: "client",
      $metadata: { httpStatusCode: 404 },
      message: "missing version",
      name: "NoSuchVersion",
    });
    Object.defineProperty(providerError, "name", {
      configurable: true,
      enumerable: true,
      value: "NoSuchVersion",
      writable: true,
    });
    vi.spyOn(S3Client.prototype, "send").mockRejectedValue(new Error("wrapped", { cause: providerError }));
    const storage = createS3ObjectStorage(options);

    await expect(storage.getObject({
      area: "quarantine",
      key: quarantineKey(),
      versionId: "version-1",
    })).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND" });
  });

  test.each(["proxy", "accessor", "prototype-proxy"] as const)(
    "maps hostile %s provider errors to unavailable without invoking traps",
    async (shape) => {
      let trapCalls = 0;
      const providerError = shape === "proxy"
        ? new Proxy({ name: "NoSuchKey", $metadata: { httpStatusCode: 404 } }, {
            get() {
              trapCalls += 1;
              throw new Error("provider trap must not run");
            },
            getOwnPropertyDescriptor() {
              trapCalls += 1;
              throw new Error("provider trap must not run");
            },
          })
        : shape === "accessor"
          ? Object.defineProperties({}, {
            name: {
              configurable: true,
              enumerable: true,
              get() {
                trapCalls += 1;
                return "NoSuchKey";
              },
            },
            $metadata: {
              configurable: true,
              enumerable: true,
              value: { httpStatusCode: 404 },
            },
          })
          : Object.assign(
              Object.create(new Proxy({}, {
                getPrototypeOf() {
                  trapCalls += 1;
                  throw new Error("provider prototype trap must not run");
                },
              })) as Record<string, unknown>,
              { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } },
            );
      vi.spyOn(S3Client.prototype, "send").mockRejectedValue(providerError);
      const storage = createS3ObjectStorage(options);

      await expect(storage.headObject({ area: "quarantine", key: quarantineKey() })).rejects.toMatchObject({
        code: "STORAGE_UNAVAILABLE",
      });
      expect(trapCalls).toBe(0);
    },
  );

  test("rejects an otherwise plausible provider record containing any untrusted accessor", async () => {
    let trapCalls = 0;
    const providerError = { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } } as Record<string, unknown>;
    Object.defineProperty(providerError, "untrusted", {
      configurable: true,
      enumerable: true,
      get() {
        trapCalls += 1;
        return "must not run";
      },
    });
    vi.spyOn(S3Client.prototype, "send").mockRejectedValue(providerError);
    const storage = createS3ObjectStorage(options);

    await expect(storage.headObject({ area: "quarantine", key: quarantineKey() })).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
    expect(trapCalls).toBe(0);
  });
});
