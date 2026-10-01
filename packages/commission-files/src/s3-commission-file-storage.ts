import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectVersionsCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { isBoundedS3Text, isProviderNotFound, isValidS3Bucket, isValidS3Endpoint, readExactNativeArray, readPlainDataRecord } from "@pawket/object-storage";

import { COMMISSION_FILE_CONTENT_TYPES } from "./file-policy.js";
import { CommissionFileStorageError, type CommissionFileStoragePort, type CommissionObjectArea } from "./storage-port.js";

export type S3CommissionFileStorageOptions = Readonly<{
  endpoint: string; region: string; accessKeyId: string; secretAccessKey: string;
  quarantineBucket: string; cleanBucket: string; forcePathStyle?: boolean; now?: () => Date;
}>;
const KEY = /^commission\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const VERSION = /^[\x21-\x7e]{1,1024}$/u;
const MAX_OBJECT_BYTES = 250 * 1024 * 1024;
const CONTENT_TYPES = new Set(Object.values(COMMISSION_FILE_CONTENT_TYPES));
const invalid = (): never => { throw new CommissionFileStorageError("invalid_input"); };
const unavailable = (): never => { throw new CommissionFileStorageError("unavailable"); };

export function createS3CommissionFileStorage(options: S3CommissionFileStorageOptions): CommissionFileStoragePort {
  if (!isValidS3Endpoint(options.endpoint) || !isBoundedS3Text(options.region, 128) || !isBoundedS3Text(options.accessKeyId, 256) ||
    !isBoundedS3Text(options.secretAccessKey, 512) || !isValidS3Bucket(options.quarantineBucket) || !isValidS3Bucket(options.cleanBucket) ||
    options.quarantineBucket === options.cleanBucket || (options.forcePathStyle !== undefined && typeof options.forcePathStyle !== "boolean")) invalid();
  const client = new S3Client({ endpoint: options.endpoint, region: options.region, forcePathStyle: options.forcePathStyle ?? true,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey } });
  const now = options.now ?? (() => new Date());
  const bucket = (area: CommissionObjectArea) => area === "quarantine" ? options.quarantineBucket : area === "clean" ? options.cleanBucket : invalid();
  const key = (value: unknown): string => typeof value === "string" && KEY.test(value) ? value : invalid();
  const version = (value: unknown): string => typeof value === "string" && VERSION.test(value) ? value : invalid();
  const seconds = (value: unknown, maximum: number): number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= maximum ? value as number : invalid();

  return {
    async presignUpload(input) {
      const objectKey = key(input.key); const expiresIn = seconds(input.expiresInSeconds, 900);
      if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 1 || input.contentLength > MAX_OBJECT_BYTES) invalid();
      const command = new PutObjectCommand({ Bucket: options.quarantineBucket, Key: objectKey, ContentType: "application/octet-stream", ContentLength: input.contentLength });
      try {
        const url = await getSignedUrl(client, command, { expiresIn, unsignableHeaders: new Set(), signableHeaders: new Set(["content-type", "content-length"]), unhoistableHeaders: new Set(["content-type", "content-length"]) });
        return { url, requiredHeaders: { "content-type": "application/octet-stream", "content-length": String(input.contentLength) }, expiresAt: new Date(now().getTime() + expiresIn * 1000) };
      } catch { return unavailable(); }
    },
    async presignDownload(input) {
      const objectKey = key(input.key); const versionId = version(input.versionId); const expiresIn = seconds(input.expiresInSeconds, 300);
      if (!CONTENT_TYPES.has(input.contentType) || typeof input.contentDisposition !== "string" || input.contentDisposition.length > 2048 ||
        !/^(attachment|inline)(; [\x20-\x7e]+)?$/u.test(input.contentDisposition)) invalid();
      const command = new GetObjectCommand({ Bucket: options.cleanBucket, Key: objectKey, VersionId: versionId, ResponseContentType: input.contentType,
        ResponseContentDisposition: input.contentDisposition, ResponseCacheControl: "private, no-store" });
      try {
        return { url: await getSignedUrl(client, command, { expiresIn }), expiresAt: new Date(now().getTime() + expiresIn * 1000) };
      } catch { return unavailable(); }
    },
    async head(area, value) {
      try {
        const response = readPlainDataRecord(await client.send(new HeadObjectCommand({ Bucket: bucket(area), Key: key(value) })));
        if (!response || !Number.isSafeInteger(response.ContentLength) || (response.ContentLength as number) < 0 || typeof response.VersionId !== "string" || !VERSION.test(response.VersionId)) return unavailable();
        return { contentLength: response.ContentLength as number, versionId: response.VersionId };
      } catch (error) {
        if (error instanceof CommissionFileStorageError) throw error;
        if (isProviderNotFound(error)) return null;
        return unavailable();
      }
    },
    async open(area, value, versionValue) {
      try {
        const response = readPlainDataRecord(await client.send(new GetObjectCommand({ Bucket: bucket(area), Key: key(value), VersionId: version(versionValue) })));
        const body = response?.Body;
        if (!body || typeof body !== "object" || !(Symbol.asyncIterator in body)) return unavailable();
        return body as AsyncIterable<Uint8Array>;
      } catch (error) {
        if (error instanceof CommissionFileStorageError) throw error;
        return unavailable();
      }
    },
    async copyToClean(input) {
      const objectKey = key(input.key); const sourceVersionId = version(input.sourceVersionId);
      if (!CONTENT_TYPES.has(input.contentType)) invalid();
      try {
        const response = readPlainDataRecord(await client.send(new CopyObjectCommand({ Bucket: options.cleanBucket, Key: objectKey,
          CopySource: `${options.quarantineBucket}/${objectKey}?versionId=${encodeURIComponent(sourceVersionId)}`, MetadataDirective: "REPLACE",
          ContentType: input.contentType, ContentDisposition: "attachment", CacheControl: "private, no-store" })));
        if (!response || typeof response.VersionId !== "string" || !VERSION.test(response.VersionId)) return unavailable();
        return { versionId: response.VersionId };
      } catch (error) {
        if (error instanceof CommissionFileStorageError) throw error;
        return unavailable();
      }
    },
    async deleteAllVersions(area, value) {
      const Bucket = bucket(area); const objectKey = key(value); let deleted = 0;
      let keyMarker: string | undefined; let versionIdMarker: string | undefined;
      try {
        for (let page = 0; page < 100; page += 1) {
          const result = readPlainDataRecord(await client.send(new ListObjectVersionsCommand({ Bucket, Prefix: objectKey, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker })));
          if (!result) return unavailable();
          const entries = [...(readExactNativeArray(result.Versions ?? []) ?? unavailable()), ...(readExactNativeArray(result.DeleteMarkers ?? []) ?? unavailable())];
          for (const candidate of entries) {
            const entry = readPlainDataRecord(candidate);
            if (!entry || typeof entry.Key !== "string" || typeof entry.VersionId !== "string") return unavailable();
            if (entry.Key !== objectKey) continue;
            await client.send(new DeleteObjectCommand({ Bucket, Key: objectKey, VersionId: entry.VersionId })); deleted += 1;
          }
          if (result.IsTruncated !== true) return deleted;
          if (typeof result.NextKeyMarker !== "string" || typeof result.NextVersionIdMarker !== "string") return unavailable();
          keyMarker = result.NextKeyMarker; versionIdMarker = result.NextVersionIdMarker;
        }
        return unavailable();
      } catch (error) {
        if (error instanceof CommissionFileStorageError) throw error;
        return unavailable();
      }
    },
    async headBucket(area) {
      try { await client.send(new HeadBucketCommand({ Bucket: bucket(area) })); } catch { unavailable(); }
    },
  };
}
