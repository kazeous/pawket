import { randomUUID } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createS3CommissionFileStorage } from "../src/index.js";
// Imported by a runtime path (not a static specifier) so `tsc --noEmit` does not pull this
// sibling package's test file into this package's rootDir-constrained program; see the
// queue/runtime modules imported the same way in
// packages/public-media/tests/media-worker.integration.test.ts.
const s3TestHelpersPath = "../../public-media/tests/s3-test-helpers.js";
const { ensureVersionedBuckets }: { ensureVersionedBuckets: (client: S3Client, buckets: readonly string[]) => Promise<void> } = await import(s3TestHelpersPath);

const endpoint = process.env.COMMISSION_FILES_S3_ENDPOINT ?? "http://127.0.0.1:9090";
const region = process.env.COMMISSION_FILES_S3_REGION ?? "us-east-1";
const accessKeyId = process.env.COMMISSION_FILES_S3_ACCESS_KEY_ID ?? "local-commission-files-key";
const secretAccessKey = process.env.COMMISSION_FILES_S3_SECRET_ACCESS_KEY ?? "local-commission-files-secret";
const quarantineBucket = process.env.COMMISSION_FILES_QUARANTINE_BUCKET ?? "pawket-commission-quarantine";
const cleanBucket = process.env.COMMISSION_FILES_CLEAN_BUCKET ?? "pawket-commission-clean";
const client = new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
const storage = createS3CommissionFileStorage({ endpoint, region, accessKeyId, secretAccessKey, quarantineBucket, cleanBucket, forcePathStyle: true });
async function collect(source: AsyncIterable<Uint8Array>) { const chunks: Uint8Array[] = []; for await (const chunk of source) chunks.push(chunk); return Buffer.concat(chunks); }

describe("commission file storage on S3Mock", () => {
  beforeAll(async () => { await ensureVersionedBuckets(client, [quarantineBucket, cleanBucket]); });
  afterAll(() => client.destroy());

  test("uploads, copies to clean, downloads and purges every version", async () => {
    const key = `commission/${randomUUID()}`; const bytes = new TextEncoder().encode("reference bytes");
    await storage.headBucket("quarantine"); await storage.headBucket("clean");
    const upload = await storage.presignUpload({ key, contentLength: bytes.byteLength, expiresInSeconds: 900 });
    expect((await fetch(upload.url, { method: "PUT", headers: upload.requiredHeaders, body: bytes })).ok).toBe(true);
    const quarantined = await storage.head("quarantine", key);
    expect(quarantined).toMatchObject({ contentLength: bytes.byteLength, versionId: expect.any(String) });
    expect(await collect(await storage.open("quarantine", key, quarantined!.versionId))).toEqual(Buffer.from(bytes));
    const copied = await storage.copyToClean({ key, sourceVersionId: quarantined!.versionId, contentType: "image/png" });
    expect(await storage.head("clean", key)).toMatchObject({ contentLength: bytes.byteLength, versionId: copied.versionId });
    const download = await storage.presignDownload({ key, versionId: copied.versionId, contentType: "image/png", contentDisposition: `attachment; filename="r.png"`, expiresInSeconds: 300 });
    const response = await fetch(download.url);
    expect(response.ok).toBe(true);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(bytes));
    expect(await storage.deleteAllVersions("quarantine", key)).toBeGreaterThanOrEqual(1);
    expect(await storage.deleteAllVersions("clean", key)).toBeGreaterThanOrEqual(1);
    expect(await storage.head("quarantine", key)).toBeNull();
    expect(await storage.head("clean", key)).toBeNull();
  });
  test("reports a missing object as null, not as an error", async () => {
    expect(await storage.head("quarantine", `commission/${randomUUID()}`)).toBeNull();
  });
});
