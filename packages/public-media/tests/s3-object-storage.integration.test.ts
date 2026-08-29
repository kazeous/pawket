import { randomUUID } from "node:crypto";
import { describe, expect, beforeAll, test } from "vitest";
import { PutBucketVersioningCommand, S3Client } from "@aws-sdk/client-s3";

import { createS3ObjectStorage } from "../src/s3-object-storage.js";

const endpoint = process.env.PUBLIC_MEDIA_S3_ENDPOINT ?? "http://localhost:9090";
const region = process.env.PUBLIC_MEDIA_S3_REGION ?? "us-east-1";
const accessKeyId = process.env.PUBLIC_MEDIA_S3_ACCESS_KEY_ID ?? "local-media-access-key";
const secretAccessKey = process.env.PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY ?? "local-media-secret-key";
const quarantineBucket = process.env.PUBLIC_MEDIA_QUARANTINE_BUCKET ?? "pawket-media-quarantine";
const derivativeBucket = process.env.PUBLIC_MEDIA_DERIVATIVE_BUCKET ?? "pawket-media-derivatives";

const client = new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
const storage = createS3ObjectStorage({ endpoint, region, accessKeyId, secretAccessKey, quarantineBucket, derivativeBucket, forcePathStyle: true });

async function readBytes(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array | string>) chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  return Buffer.concat(chunks);
}

describe("private S3 object storage", () => {
  beforeAll(async () => {
    for (const Bucket of [quarantineBucket, derivativeBucket]) await client.send(new PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: "Enabled" } }));
  });

  test("presigns, PUTs, HEADs, GETs, lists, overwrites, and deletes exact versions", async () => {
    const key = `quarantine/${randomUUID()}/${randomUUID()}`;
    const bytes = new Uint8Array([1, 2, 3]);
    const grant = await storage.presignPut({ key, contentType: "image/png", contentLength: bytes.byteLength, expiresInSeconds: 900 });
    expect(grant.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(900_000);
    expect(new URL(grant.url).searchParams.get("X-Amz-SignedHeaders")).toContain("content-type");
    expect(new URL(grant.url).searchParams.get("X-Amz-SignedHeaders")).toContain("content-length");
    const response = await fetch(grant.url, { method: "PUT", headers: grant.requiredHeaders, body: bytes });
    expect(response.ok).toBe(true);
    const first = await storage.headObject({ area: "quarantine", key });
    expect(first).toMatchObject({ contentLength: 3, contentType: "image/png", versionId: expect.any(String) });
    await fetch(grant.url, { method: "PUT", headers: grant.requiredHeaders, body: new Uint8Array([4, 5, 6]) });
    const second = await storage.headObject({ area: "quarantine", key });
    expect(second?.versionId).not.toBe(first?.versionId);
    expect(new Uint8Array(await readBytes(await storage.getObject({ area: "quarantine", key, versionId: first!.versionId! })))).toEqual(bytes);
    expect(await storage.listObjectVersions({ area: "quarantine", key })).toEqual(expect.arrayContaining([{ versionId: first!.versionId, isDeleteMarker: false }, { versionId: second!.versionId, isDeleteMarker: false }]));
    await storage.deleteObject({ area: "quarantine", key, versionId: first!.versionId! });
    expect((await storage.listObjectVersions({ area: "quarantine", key })).map((version) => version.versionId)).not.toContain(first!.versionId);
  });

  test("stores private derivative SHA metadata and maps invalid/missing objects safely", async () => {
    const assetId = randomUUID();
    const key = `derivatives/${assetId}/display/${randomUUID()}.webp`;
    const hash = "sha256:v1:" + "a".repeat(43);
    await storage.putObject({ area: "derivative", key, contentType: "image/webp", body: new Uint8Array([8, 9]), sha256: hash });
    expect(await storage.headObject({ area: "derivative", key })).toMatchObject({ contentLength: 2, contentType: "image/webp", sha256: hash, versionId: expect.any(String) });
    await expect(storage.headObject({ area: "invalid", key } as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(storage.presignPut({ key: "quarantine/nope", contentType: "image/gif", contentLength: 1, expiresInSeconds: 900 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await storage.headObject({ area: "quarantine", key: `quarantine/${randomUUID()}/${randomUUID()}` })).toBeNull();
  });
});
