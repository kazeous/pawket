import { randomUUID } from "node:crypto";

import { S3Client } from "@aws-sdk/client-s3";
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
});
