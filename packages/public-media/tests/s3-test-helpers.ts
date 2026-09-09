import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

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

export async function deleteEveryS3ObjectVersion(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<void> {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  for (let page = 0; page < 1000; page += 1) {
    const result = await client.send(new ListObjectVersionsCommand({
      Bucket: bucket,
      Prefix: key,
      KeyMarker: keyMarker,
      VersionIdMarker: versionIdMarker,
    }));
    const entries = [...(result.Versions ?? []), ...(result.DeleteMarkers ?? [])];
    for (const entry of entries) {
      if (entry.Key === key && typeof entry.VersionId === "string" && entry.VersionId.length > 0) {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: entry.VersionId }));
      }
    }
    if (result.IsTruncated !== true) return;
    if (typeof result.NextKeyMarker !== "string" || typeof result.NextVersionIdMarker !== "string") {
      throw new Error("S3 cleanup pagination was truncated without exact markers");
    }
    keyMarker = result.NextKeyMarker;
    versionIdMarker = result.NextVersionIdMarker;
  }
  throw new Error("S3 cleanup pagination exceeded its safety bound");
}

export async function runCleanupSteps(
  preservePrimaryFailure: boolean,
  steps: readonly (() => Promise<void>)[],
): Promise<void> {
  let firstCleanupFailure: unknown;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      firstCleanupFailure ??= error;
    }
  }
  if (!preservePrimaryFailure && firstCleanupFailure !== undefined) throw firstCleanupFailure;
}
