import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { HeadObjectResult, ObjectLocation, ObjectStoragePort } from "./object-storage-port.js";
import { MediaPolicyError } from "./media-policy.js";

export type S3ObjectStorageOptions = Readonly<{
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  quarantineBucket: string;
  derivativeBucket: string;
  forcePathStyle?: boolean;
  /** Allows deterministic expiry assertions in tests without weakening the 15-minute API contract. */
  now?: () => Date;
}>;

function bucketFor(options: S3ObjectStorageOptions, area: ObjectLocation["area"]): string {
  return area === "quarantine" ? options.quarantineBucket : options.derivativeBucket;
}

function validateKey(key: string): void {
  if (!key || key.length > 1024 || key.startsWith("/") || key.includes("..") || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw new MediaPolicyError("INVALID_INPUT");
  }
}

function validateAreaKey(location: ObjectLocation): void {
  validateKey(location.key);
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const pattern = location.area === "quarantine"
    ? new RegExp(`^quarantine/${uuid}/${uuid}$`, "u")
    : new RegExp(`^derivatives/${uuid}/(master|thumb|display|large)/[A-Za-z0-9_-]+[.]webp$`, "u");
  if (!pattern.test(location.key)) throw new MediaPolicyError("INVALID_INPUT");
}

function validateEndpoint(endpoint: string): void {
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
  } catch {
    throw new MediaPolicyError("INVALID_INPUT");
  }
}

export function createS3ObjectStorage(options: S3ObjectStorageOptions): ObjectStoragePort {
  validateEndpoint(options.endpoint);
  if (!options.region || !options.accessKeyId || !options.secretAccessKey || !options.quarantineBucket || !options.derivativeBucket || options.quarantineBucket === options.derivativeBucket) {
    throw new MediaPolicyError("INVALID_INPUT");
  }
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: options.forcePathStyle ?? true,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
  });
  const now = options.now ?? (() => new Date());

  function locationParts(location: ObjectLocation) {
    validateAreaKey(location);
    return { Bucket: bucketFor(options, location.area), Key: location.key, ...(location.versionId ? { VersionId: location.versionId } : {}) };
  }

  return {
    async presignPut(input) {
      validateAreaKey({ area: "quarantine", key: input.key });
      if (!Number.isInteger(input.contentLength) || input.contentLength < 1 || input.contentLength > 10 * 1024 * 1024 || input.expiresInSeconds !== 900 || !input.contentType || input.contentType.length > 128) throw new MediaPolicyError("INVALID_INPUT");
      const expiresAt = new Date(now().getTime() + input.expiresInSeconds * 1000);
      const command = new PutObjectCommand({
        Bucket: options.quarantineBucket,
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
      });
      try {
        const url = await getSignedUrl(client, command, { expiresIn: input.expiresInSeconds });
        return { url, requiredHeaders: { "content-type": input.contentType, "content-length": String(input.contentLength) }, expiresAt };
      } catch {
        throw new MediaPolicyError("STORAGE_UNAVAILABLE");
      }
    },

    async headObject(location) {
      try {
        const result = await client.send(new HeadObjectCommand(locationParts(location)));
        return {
          contentLength: Number(result.ContentLength ?? 0),
          contentType: result.ContentType ?? null,
          etag: result.ETag ?? null,
          versionId: result.VersionId ?? null,
          sha256: result.Metadata?.sha256 ?? null,
        } satisfies HeadObjectResult;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw new MediaPolicyError("STORAGE_UNAVAILABLE");
      }
    },

    async listObjectVersions(location) {
      const parts = locationParts(location);
      try {
        const result = await client.send(new ListObjectVersionsCommand({ Bucket: parts.Bucket, Prefix: parts.Key }));
        const versions = (result.Versions ?? []).filter((item) => item.Key === parts.Key).map((item) => ({ versionId: item.VersionId ?? "", isDeleteMarker: false }));
        const markers = (result.DeleteMarkers ?? []).filter((item) => item.Key === parts.Key).map((item) => ({ versionId: item.VersionId ?? "", isDeleteMarker: true }));
        return [...versions, ...markers].filter((item) => item.versionId.length > 0);
      } catch (error) {
        if (isNotFound(error)) return [];
        throw new MediaPolicyError("STORAGE_UNAVAILABLE");
      }
    },

    async getObject(location) {
      try {
        const result = await client.send(new GetObjectCommand(locationParts(location)));
        if (!result.Body) throw new MediaPolicyError("STORAGE_ERROR");
        return result.Body as NodeJS.ReadableStream;
      } catch (error) {
        if (error instanceof MediaPolicyError) throw error;
        if (isNotFound(error)) throw new MediaPolicyError("MEDIA_NOT_FOUND");
        throw new MediaPolicyError("STORAGE_UNAVAILABLE");
      }
    },

    async putObject(input) {
      validateAreaKey(input);
      if (input.area !== "derivative" || input.contentType !== "image/webp" || input.body.byteLength < 1 || input.body.byteLength > 10 * 1024 * 1024 || !/^sha256:v1:[A-Za-z0-9_-]{43}$/u.test(input.sha256)) throw new MediaPolicyError("INVALID_INPUT");
      try {
        await client.send(new PutObjectCommand({ Bucket: options.derivativeBucket, Key: input.key, Body: input.body, ContentType: "image/webp", ContentLength: input.body.byteLength, Metadata: { sha256: input.sha256 } }));
      } catch {
        throw new MediaPolicyError("STORAGE_UNAVAILABLE");
      }
    },

    async deleteObject(location) {
      try {
        await client.send(new DeleteObjectCommand(locationParts(location)));
      } catch {
        throw new MediaPolicyError("STORAGE_UNAVAILABLE");
      }
    },
  };
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "NotFound" || candidate.name === "NoSuchKey" || candidate.name === "NoSuchVersion" || candidate.$metadata?.httpStatusCode === 404;
}
