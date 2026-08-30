import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { types as nodeTypes } from "node:util";

import type { HeadObjectResult, ObjectLocation, ObjectStoragePort } from "./object-storage-port.js";
import { isOpaqueVersionId, isRawStorageEtag, MediaPolicyError } from "./media-policy.js";
import { readExactNativeArray, readExactOwnRecord, readPlainDataRecord } from "./runtime-boundary.js";

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

const SOURCE_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

function bucketFor(options: S3ObjectStorageOptions, area: ObjectLocation["area"]): string {
  return area === "quarantine" ? options.quarantineBucket : options.derivativeBucket;
}

function validateKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !key || key.length > 1024 || key.startsWith("/") || key.includes("..") || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw new MediaPolicyError("INVALID_INPUT");
  }
}

function validateAreaKey(value: unknown): ObjectLocation {
  const location = readExactOwnRecord(value, ["area", "key"], ["versionId"]);
  if (!location || (location.area !== "quarantine" && location.area !== "derivative")) throw new MediaPolicyError("INVALID_INPUT");
  if (location.versionId !== undefined && !isOpaqueVersionId(location.versionId)) throw new MediaPolicyError("INVALID_INPUT");
  validateKey(location.key);
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const pattern = location.area === "quarantine"
    ? new RegExp(`^quarantine/${uuid}/${uuid}$`, "u")
    : new RegExp(`^derivatives/${uuid}/(master|thumb|display|large)/[A-Za-z0-9_-]+[.]webp$`, "u");
  if (!pattern.test(location.key)) throw new MediaPolicyError("INVALID_INPUT");
  return { area: location.area, key: location.key, ...(location.versionId === undefined ? {} : { versionId: location.versionId }) };
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
  const optionRecord = readExactOwnRecord(options, ["endpoint", "region", "accessKeyId", "secretAccessKey", "quarantineBucket", "derivativeBucket"], ["forcePathStyle", "now"]);
  if (!optionRecord) throw new MediaPolicyError("INVALID_INPUT");
  validateEndpoint(optionRecord.endpoint as string);
  if (typeof optionRecord.region !== "string" || !optionRecord.region || optionRecord.region.length > 128 || /[\u0000-\u001f\u007f]/u.test(optionRecord.region) || typeof optionRecord.accessKeyId !== "string" || !optionRecord.accessKeyId || optionRecord.accessKeyId.length > 256 || /[\u0000-\u001f\u007f]/u.test(optionRecord.accessKeyId) || typeof optionRecord.secretAccessKey !== "string" || !optionRecord.secretAccessKey || optionRecord.secretAccessKey.length > 512 || /[\u0000-\u001f\u007f]/u.test(optionRecord.secretAccessKey) || typeof optionRecord.quarantineBucket !== "string" || typeof optionRecord.derivativeBucket !== "string" || !optionRecord.quarantineBucket || !optionRecord.derivativeBucket || optionRecord.quarantineBucket === optionRecord.derivativeBucket || (optionRecord.forcePathStyle !== undefined && typeof optionRecord.forcePathStyle !== "boolean") || (optionRecord.now !== undefined && typeof optionRecord.now !== "function")) {
    throw new MediaPolicyError("INVALID_INPUT");
  }
  const safeOptions: S3ObjectStorageOptions = {
    endpoint: optionRecord.endpoint as string,
    region: optionRecord.region,
    accessKeyId: optionRecord.accessKeyId,
    secretAccessKey: optionRecord.secretAccessKey,
    quarantineBucket: optionRecord.quarantineBucket,
    derivativeBucket: optionRecord.derivativeBucket,
    ...(optionRecord.forcePathStyle === undefined ? {} : { forcePathStyle: optionRecord.forcePathStyle as boolean }),
    ...(optionRecord.now === undefined ? {} : { now: optionRecord.now as () => Date }),
  };
  validateBucket(safeOptions.quarantineBucket);
  validateBucket(safeOptions.derivativeBucket);
  const client = new S3Client({
    endpoint: safeOptions.endpoint,
    region: safeOptions.region,
    forcePathStyle: safeOptions.forcePathStyle ?? true,
    credentials: { accessKeyId: safeOptions.accessKeyId, secretAccessKey: safeOptions.secretAccessKey },
  });
  const now = safeOptions.now ?? (() => new Date());

  function locationParts(value: unknown) {
    const location = validateAreaKey(value);
    return { Bucket: bucketFor(safeOptions, location.area), Key: location.key, ...(location.versionId ? { VersionId: location.versionId } : {}) };
  }

  return {
    async presignPut(input) {
      const request = readExactOwnRecord(input, ["key", "contentType", "contentLength", "expiresInSeconds"]);
      if (!request || typeof request.contentType !== "string") throw new MediaPolicyError("INVALID_INPUT");
      const location = validateAreaKey({ area: "quarantine", key: request.key });
      const contentType = request.contentType;
      if (!Number.isSafeInteger(request.contentLength) || (request.contentLength as number) < 1 || (request.contentLength as number) > 10 * 1024 * 1024 || !Number.isInteger(request.expiresInSeconds) || (request.expiresInSeconds as number) < 1 || (request.expiresInSeconds as number) > 900 || !SOURCE_CONTENT_TYPES.includes(contentType as (typeof SOURCE_CONTENT_TYPES)[number])) throw new MediaPolicyError("INVALID_INPUT");
      const contentLength = request.contentLength as number;
      const expiresInSeconds = request.expiresInSeconds as number;
      const expiresAt = new Date(now().getTime() + expiresInSeconds * 1000);
      const command = new PutObjectCommand({
        Bucket: safeOptions.quarantineBucket,
        Key: location.key,
        ContentType: contentType,
        ContentLength: contentLength,
      });
      try {
        const url = await getSignedUrl(client, command, { expiresIn: expiresInSeconds, unsignableHeaders: new Set(), signableHeaders: new Set(["content-type", "content-length"]), unhoistableHeaders: new Set(["content-type", "content-length"]) });
        return { url, requiredHeaders: { "content-type": contentType, "content-length": String(contentLength) }, expiresAt };
      } catch {
        throw new MediaPolicyError("STORAGE_UNAVAILABLE");
      }
    },

    async headObject(location) {
      const parts = locationParts(location);
      try {
        const response = readPlainDataRecord(await client.send(new HeadObjectCommand(parts)));
        if (!response) throw new Error("malformed HEAD response");
        const metadata = response.Metadata === undefined ? null : readPlainDataRecord(response.Metadata);
        if (response.Metadata !== undefined && !metadata) throw new Error("malformed HEAD metadata");
        const versionId = response.VersionId;
        const contentType = response.ContentType;
        const etag = response.ETag;
        const sha256 = metadata?.sha256;
        const contentLength = response.ContentLength;
        if (!isOpaqueVersionId(versionId) || !Number.isSafeInteger(contentLength) || (contentLength as number) < 0 || !SOURCE_CONTENT_TYPES.includes(contentType as (typeof SOURCE_CONTENT_TYPES)[number]) || !isRawStorageEtag(etag) || (sha256 !== undefined && (typeof sha256 !== "string" || !/^sha256:v1:[A-Za-z0-9_-]{43}$/u.test(sha256)))) throw new Error("malformed HEAD evidence");
        return {
          contentLength: contentLength as number,
          contentType: contentType as (typeof SOURCE_CONTENT_TYPES)[number],
          etag,
          versionId,
          sha256: sha256 ?? null,
        } satisfies HeadObjectResult;
      } catch (error) {
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
        const observedMarkers = new Set([paginationMarkerTuple(keyMarker, versionIdMarker)]);
        for (let page = 0; page < 1000; page += 1) {
          const result = readPlainDataRecord(await client.send(new ListObjectVersionsCommand({ Bucket: parts.Bucket, Prefix: parts.Key, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker })));
          if (!result || (result.IsTruncated !== undefined && typeof result.IsTruncated !== "boolean")) throw new Error("malformed version listing");
          const versions = result.Versions === undefined ? [] : readExactNativeArray(result.Versions);
          const deleteMarkers = result.DeleteMarkers === undefined ? [] : readExactNativeArray(result.DeleteMarkers);
          if (!versions || !deleteMarkers) throw new Error("malformed version listing entries");
          for (const candidate of versions) {
            const item = readPlainDataRecord(candidate);
            if (!item || item.Key !== parts.Key || !isOpaqueVersionId(item.VersionId)) throw new Error("malformed object version");
            output.push({ versionId: item.VersionId, isDeleteMarker: false });
          }
          for (const candidate of deleteMarkers) {
            const item = readPlainDataRecord(candidate);
            if (!item || item.Key !== parts.Key || !isOpaqueVersionId(item.VersionId)) throw new Error("malformed delete marker");
            output.push({ versionId: item.VersionId, isDeleteMarker: true });
          }
          if (result.IsTruncated !== true) return output;
          if (result.NextKeyMarker !== parts.Key || !isOpaqueVersionId(result.NextVersionIdMarker)) throw new Error("malformed version pagination");
          const nextMarkers = paginationMarkerTuple(result.NextKeyMarker, result.NextVersionIdMarker);
          if (observedMarkers.has(nextMarkers)) throw new Error("cyclic version pagination");
          observedMarkers.add(nextMarkers);
          keyMarker = result.NextKeyMarker;
          versionIdMarker = result.NextVersionIdMarker;
        }
        throw new Error("version pagination exceeded bound");
      } catch (error) {
        if (isNotFound(error)) return [];
        throw new MediaPolicyError("STORAGE_UNAVAILABLE");
      }
    },

    async getObject(location) {
      const parts = locationParts(location);
      try {
        const result = readPlainDataRecord(await client.send(new GetObjectCommand(parts)));
        if (!result?.Body || !(typeof result.Body === "object" && ("pipe" in result.Body || Symbol.asyncIterator in result.Body))) throw new Error("malformed GET response");
        return result.Body as NodeJS.ReadableStream;
      } catch (error) {
        if (isNotFound(error)) throw new MediaPolicyError("MEDIA_NOT_FOUND");
        throw new MediaPolicyError("STORAGE_UNAVAILABLE");
      }
    },

    async putObject(input) {
      const request = readExactOwnRecord(input, ["area", "key", "contentType", "body", "sha256"], ["versionId"]);
      if (!request || !(request.body instanceof Uint8Array) || typeof request.sha256 !== "string") throw new MediaPolicyError("INVALID_INPUT");
      const location = validateAreaKey({ area: request.area, key: request.key, ...(request.versionId === undefined ? {} : { versionId: request.versionId }) });
      if (location.area !== "derivative" || request.contentType !== "image/webp" || request.body.byteLength < 1 || request.body.byteLength > 10 * 1024 * 1024 || !/^sha256:v1:[A-Za-z0-9_-]{43}$/u.test(request.sha256)) throw new MediaPolicyError("INVALID_INPUT");
      try {
        await client.send(new PutObjectCommand({ Bucket: safeOptions.derivativeBucket, Key: location.key, Body: request.body, ContentType: "image/webp", ContentLength: request.body.byteLength, Metadata: { sha256: request.sha256 } }));
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
  const visited = new Set<object>();
  let candidate: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!candidate || typeof candidate !== "object" || nodeTypes.isProxy(candidate) || visited.has(candidate)) return false;
    visited.add(candidate);
    if (!hasSafeProviderErrorShape(candidate)) return false;

    const name = readOwnDataValue(candidate, "name");
    if (name.kind === "accessor") return false;
    const metadata = readOwnDataValue(candidate, "$metadata");
    if (metadata.kind === "accessor") return false;
    if (
      name.kind === "data" &&
      (name.value === "NotFound" || name.value === "NoSuchKey" || name.value === "NoSuchVersion")
    ) return true;
    if (metadata.kind === "data" && hasSafeNotFoundStatus(metadata.value)) return true;

    const cause = readOwnDataValue(candidate, "cause");
    if (cause.kind === "accessor" || cause.kind === "missing") return false;
    candidate = cause.value;
  }
  return false;
}

function hasSafeProviderErrorShape(value: object): boolean {
  let current: object | null = value;
  let allowsNativeStackAccessor = false;
  let recognizedPrototype = false;
  for (let depth = 0; depth < 8; depth += 1) {
    if (nodeTypes.isProxy(current)) return false;
    let prototype: object | null;
    try {
      prototype = Object.getPrototypeOf(current);
    } catch {
      return false;
    }
    if (prototype === Object.prototype) {
      recognizedPrototype = true;
      break;
    }
    if (prototype === Error.prototype) {
      allowsNativeStackAccessor = true;
      recognizedPrototype = true;
      break;
    }
    if (prototype === null || nodeTypes.isProxy(prototype)) return false;
    current = prototype;
  }
  if (!recognizedPrototype) return false;
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of ownKeys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor) return false;
      if (!("value" in descriptor) && !(allowsNativeStackAccessor && key === "stack" && descriptor.enumerable === false)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

type OwnDataValue =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "accessor" }>
  | Readonly<{ kind: "data"; value: unknown }>;

function readOwnDataValue(value: object, key: string): OwnDataValue {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { kind: "missing" };
    if (!("value" in descriptor)) return { kind: "accessor" };
    return { kind: "data", value: descriptor.value };
  } catch {
    return { kind: "accessor" };
  }
}

function hasSafeNotFoundStatus(value: unknown): boolean {
  const metadata = readPlainDataRecord(value);
  return metadata?.httpStatusCode === 404;
}

function paginationMarkerTuple(keyMarker: string | undefined, versionIdMarker: string | undefined): string {
  return JSON.stringify([keyMarker ?? null, versionIdMarker ?? null]);
}
