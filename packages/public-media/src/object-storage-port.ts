export type ObjectLocation = Readonly<{
  area: "quarantine" | "derivative";
  key: string;
  versionId?: string;
}>;

export type HeadObjectResult = Readonly<{
  contentLength: number;
  contentType: string | null;
  etag: string | null;
  versionId: string | null;
  sha256: string | null;
}>;

export type PutObjectResult = Readonly<{ versionId: string }>;

export class ObjectStorageConflictError extends Error {
  constructor() {
    super("OBJECT_ALREADY_EXISTS");
    this.name = "ObjectStorageConflictError";
  }
}

export type ObjectStoragePort = Readonly<{
  presignPut(input: { key: string; contentType: string; contentLength: number; expiresInSeconds: number }): Promise<{ url: string; requiredHeaders: Record<string, string>; expiresAt: Date }>;
  /** Availability probe for one bounded storage area. Requires an `s3:ListBucket` grant. */
  headBucket(area: ObjectLocation["area"], signal?: AbortSignal): Promise<void>;
  headObject(location: ObjectLocation): Promise<HeadObjectResult | null>;
  listObjectVersions(location: Omit<ObjectLocation, "versionId">): Promise<readonly { versionId: string; isDeleteMarker: boolean }[]>;
  getObject(location: ObjectLocation): Promise<NodeJS.ReadableStream>;
  putObject(input: ObjectLocation & { area: "derivative"; contentType: "image/webp"; body: Uint8Array; sha256: string; createOnly?: true }): Promise<PutObjectResult>;
  deleteObject(location: ObjectLocation): Promise<void>;
}>;
