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
  if (typeof key !== "string" || !key || key.length > 1024 || key.startsWith("/") || key.includes("..") || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw new MediaPolicyError("INVALID_INPUT");
  }
}

function validateAreaKey(location: ObjectLocation): void {
  if (!location || typeof location !== "object") throw new MediaPolicyError("INVALID_INPUT");
  if (location.area !== "quarantine" && location.area !== "derivative") throw new MediaPolicyError("INVALID_INPUT");
  if (location.versionId !== undefined && (typeof location.versionId !== "string" || !location.versionId || location.versionId === "null" || location.versionId.length > 512)) throw new MediaPolicyError("INVALID_INPUT");
  validateKey(location.key);
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const pattern = location.area === "quarantine"
    ? new RegExp(`^quarantine/${uuid}/${uuid}$`, "u")
    : new RegExp(`^derivatives/${uuid}/(master|thumb|display|large)/[A-Za-z0-9_-]+[.]webp$`, "u");
  if (!pattern.test(location.key)) throw new MediaPolicyError("INVALID_INPUT");
}

function validateEndpoint(endpoint: string): void {
  if (typeof endpoint !== "string") throw new MediaPolicyError("INVALID_INPUT");
  try {
    const parsed = new URL(endpoint);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("endpoint");
  } catch {
    throw new MediaPolicyError("INVALID_INPUT");
  }
}

function validateBucket(bucket: string): void {
  if (typeof bucket !== "string" || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(bucket) || bucket.length < 3 || bucket.length > 63) throw new MediaPolicyError("INVALID_INPUT");
}

export function createS3ObjectStorage(options: S3ObjectStorageOptions): ObjectStoragePort {
  if (!options || typeof options !== "object") throw new MediaPolicyError("INVALID_INPUT");
  validateEndpoint(options.endpoint);
  if (typeof options.region !== "string" || !options.region || options.region.length > 128 || /[\u0000-\u001f\u007f]/u.test(options.region) || typeof options.accessKeyId !== "string" || !options.accessKeyId || options.accessKeyId.length > 256 || /[\u0000-\u001f\u007f]/u.test(options.accessKeyId) || typeof options.secretAccessKey !== "string" || !options.secretAccessKey || options.secretAccessKey.length > 512 || /[\u0000-\u001f\u007f]/u.test(options.secretAccessKey) || typeof options.quarantineBucket !== "string" || typeof options.derivativeBucket !== "string" || !options.quarantineBucket || !options.derivativeBucket || options.quarantineBucket === options.derivativeBucket || (options.forcePathStyle !== undefined && typeof options.forcePathStyle !== "boolean") || (options.now !== undefined && typeof options.now !== "function")) {
    throw new MediaPolicyError("INVALID_INPUT");
  }
  validateBucket(options.quarantineBucket);
  validateBucket(options.derivativeBucket);
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
      if (!input || typeof input !== "object" || typeof input.contentType !== "string") throw new MediaPolicyError("INVALID_INPUT");
      validateAreaKey({ area: "quarantine", key: input.key });
      const contentType = input.contentType.trim().toLowerCase();
      if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 1 || input.contentLength > 10 * 1024 * 1024 || !Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds < 1 || input.expiresInSeconds > 900 || !["image/jpeg", "image/png", "image/webp"].includes(contentType) || contentType.length > 128) throw new MediaPolicyError("INVALID_INPUT");
      const expiresAt = new Date(now().getTime() + input.expiresInSeconds * 1000);
      const command = new PutObjectCommand({
        Bucket: options.quarantineBucket,
        Key: input.key,
        ContentType: contentType,
        ContentLength: input.contentLength,
      });
      try {
        const url = await getSignedUrl(client, command, { expiresIn: input.expiresInSeconds, unsignableHeaders: new Set(), signableHeaders: new Set(["content-type", "content-length"]), unhoistableHeaders: new Set(["content-type", "content-length"]) });
        return { url, requiredHeaders: { "content-type": contentType, "content-length": String(input.contentLength) }, expiresAt };
      } catch {
        throw new MediaPolicyError("STORAGE_UNAVAILABLE");
      }
    },

    async headObject(location) {
      const parts = locationParts(location);
      try {
        const result = await client.send(new HeadObjectCommand(parts));
        if (!result || typeof result !== "object") throw new MediaPolicyError("STORAGE_ERROR");
        const versionId = result.VersionId;
        const contentType = typeof result.ContentType === "string" ? result.ContentType.trim().toLowerCase() : "";
        const etag = typeof result.ETag === "string" ? result.ETag.trim() : "";
        const sha256 = result.Metadata?.sha256;
        const contentLength = result.ContentLength;
        if (typeof versionId !== "string" || !versionId || versionId === "null" || versionId.length > 512 || /[\u0000-\u001f\u007f]/u.test(versionId) || typeof contentLength !== "number" || !Number.isSafeInteger(contentLength) || contentLength < 0 || !contentType || contentType.length > 128 || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(contentType) || !etag || etag.length > 512 || /[\u0000-\u001f\u007f]/u.test(etag) || (sha256 !== undefined && (typeof sha256 !== "string" || !/^sha256:v1:[A-Za-z0-9_-]{43}$/u.test(sha256)))) throw new MediaPolicyError("STORAGE_ERROR");
        return {
          contentLength,
          contentType,
          etag,
          versionId,
          sha256: sha256 ?? null,
        } satisfies HeadObjectResult;
      } catch (error) {
        if (error instanceof MediaPolicyError) throw error;
        if (isNotFound(error)) return null;
        throw new MediaPolicyError("STORAGE_UNAVAILABLE");
      }
    },

    async listObjectVersions(location) {
      const parts = locationParts(location);
      try {
        const output: { versionId: string; isDeleteMarker: boolean }[] = [];
        let keyMarker: string | undefined;
        let versionIdMarker: string | undefined;
        for (let page = 0; page < 1000; page += 1) {
          const result = await client.send(new ListObjectVersionsCommand({ Bucket: parts.Bucket, Prefix: parts.Key, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker }));
          if (!result || typeof result !== "object" || (result.IsTruncated !== undefined && typeof result.IsTruncated !== "boolean") || (result.Versions !== undefined && !Array.isArray(result.Versions)) || (result.DeleteMarkers !== undefined && !Array.isArray(result.DeleteMarkers))) throw new MediaPolicyError("STORAGE_ERROR");
          for (const item of result.Versions ?? []) {
            if (!item || typeof item !== "object" || typeof item.Key !== "string" || item.Key !== parts.Key || typeof item.VersionId !== "string" || !item.VersionId || item.VersionId === "null" || item.VersionId.length > 512 || /[\u0000-\u001f\u007f]/u.test(item.VersionId)) throw new MediaPolicyError("STORAGE_ERROR");
            output.push({ versionId: item.VersionId, isDeleteMarker: false });
          }
          for (const item of result.DeleteMarkers ?? []) {
            if (!item || typeof item !== "object" || typeof item.Key !== "string" || item.Key !== parts.Key || typeof item.VersionId !== "string" || !item.VersionId || item.VersionId === "null" || item.VersionId.length > 512 || /[\u0000-\u001f\u007f]/u.test(item.VersionId)) throw new MediaPolicyError("STORAGE_ERROR");
            output.push({ versionId: item.VersionId, isDeleteMarker: true });
          }
          if (result.IsTruncated !== true) return output;
          if (typeof result.NextKeyMarker !== "string" || !result.NextKeyMarker || result.NextKeyMarker === "null" || (result.NextVersionIdMarker !== undefined && (typeof result.NextVersionIdMarker !== "string" || !result.NextVersionIdMarker || result.NextVersionIdMarker === "null")) || (result.NextKeyMarker === keyMarker && result.NextVersionIdMarker === versionIdMarker)) throw new MediaPolicyError("STORAGE_ERROR");
          keyMarker = result.NextKeyMarker;
          versionIdMarker = result.NextVersionIdMarker;
        }
        throw new MediaPolicyError("STORAGE_ERROR");
      } catch (error) {
        if (error instanceof MediaPolicyError) throw error;
        if (isNotFound(error)) return [];
        throw new MediaPolicyError("STORAGE_UNAVAILABLE");
      }
    },

    async getObject(location) {
      const parts = locationParts(location);
      try {
        const result = await client.send(new GetObjectCommand(parts));
        if (!result.Body || !(typeof result.Body === "object" && ("pipe" in result.Body || Symbol.asyncIterator in result.Body))) throw new MediaPolicyError("STORAGE_ERROR");
        return result.Body as NodeJS.ReadableStream;
      } catch (error) {
        if (error instanceof MediaPolicyError) throw error;
        if (isNotFound(error)) throw new MediaPolicyError("MEDIA_NOT_FOUND");
        throw new MediaPolicyError("STORAGE_UNAVAILABLE");
      }
    },

    async putObject(input) {
      if (!input || typeof input !== "object" || !(input.body instanceof Uint8Array) || typeof input.sha256 !== "string") throw new MediaPolicyError("INVALID_INPUT");
      validateAreaKey(input);
      if (input.area !== "derivative" || input.contentType !== "image/webp" || input.body.byteLength < 1 || input.body.byteLength > 10 * 1024 * 1024 || !/^sha256:v1:[A-Za-z0-9_-]{43}$/u.test(input.sha256)) throw new MediaPolicyError("INVALID_INPUT");
      try {
        await client.send(new PutObjectCommand({ Bucket: options.derivativeBucket, Key: input.key, Body: input.body, ContentType: "image/webp", ContentLength: input.body.byteLength, Metadata: { sha256: input.sha256 } }));
      } catch {
        throw new MediaPolicyError("STORAGE_UNAVAILABLE");
      }
    },

    async deleteObject(location) {
      const parts = locationParts(location);
      try {
        await client.send(new DeleteObjectCommand(parts));
      } catch (error) {
        if (isNotFound(error)) throw new MediaPolicyError("MEDIA_NOT_FOUND");
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
