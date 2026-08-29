import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";

import { createS3ObjectStorage } from "../src/s3-object-storage.js";

const endpoint = process.env.PUBLIC_MEDIA_S3_ENDPOINT;
const enabled = Boolean(endpoint && process.env.PUBLIC_MEDIA_QUARANTINE_BUCKET && process.env.PUBLIC_MEDIA_DERIVATIVE_BUCKET && process.env.PUBLIC_MEDIA_S3_ACCESS_KEY_ID && process.env.PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY);

describe.skipIf(!enabled)("private S3 object storage", () => {
  test("presigns quarantine PUTs and reads the exact versioned object", async () => {
    const storage = createS3ObjectStorage({
      endpoint: endpoint!,
      region: process.env.PUBLIC_MEDIA_S3_REGION ?? "us-east-1",
      accessKeyId: process.env.PUBLIC_MEDIA_S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY!,
      quarantineBucket: process.env.PUBLIC_MEDIA_QUARANTINE_BUCKET!,
      derivativeBucket: process.env.PUBLIC_MEDIA_DERIVATIVE_BUCKET!,
      forcePathStyle: true,
    });
    const key = `quarantine/${randomUUID()}/${randomUUID()}`;
    const bytes = new Uint8Array([1, 2, 3]);
    const grant = await storage.presignPut({ key, contentType: "image/png", contentLength: bytes.byteLength, expiresInSeconds: 900 });
    expect(grant.url).not.toContain(process.env.PUBLIC_MEDIA_S3_ACCESS_KEY_ID!);
    const response = await fetch(grant.url, { method: "PUT", headers: grant.requiredHeaders, body: bytes });
    expect(response.ok).toBe(true);
    const head = await storage.headObject({ area: "quarantine", key });
    expect(head).toMatchObject({ contentLength: 3, contentType: "image/png", versionId: expect.any(String) });
    await storage.deleteObject({ area: "quarantine", key, versionId: head!.versionId! });
  });
});
