import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketVersioningCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

import type { ObjectLocation, ObjectStoragePort } from "../src/object-storage-port.js";

function isMissingBucket(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "NoSuchBucket" || candidate.name === "NotFound" || candidate.$metadata?.httpStatusCode === 404;
}

export async function ensureVersionedBuckets(client: S3Client, buckets: readonly string[]): Promise<void> {
  for (const Bucket of buckets) {
    try {
      await client.send(new HeadBucketCommand({ Bucket }));
    } catch (error) {
      if (!isMissingBucket(error)) throw error;
      await client.send(new CreateBucketCommand({ Bucket }));
    }
    await client.send(new PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: "Enabled" } }));
  }
}

export async function deleteEveryObjectVersion(
  storage: ObjectStoragePort,
  location: Omit<ObjectLocation, "versionId">,
): Promise<void> {
  for (const version of await storage.listObjectVersions(location)) {
    await storage.deleteObject({ ...location, versionId: version.versionId });
  }
}
