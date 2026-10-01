export type CommissionObjectArea = "quarantine" | "clean";
export class CommissionFileStorageError extends Error {
  constructor(readonly code: "invalid_input" | "unavailable") { super(code); this.name = "CommissionFileStorageError"; }
}
export type CommissionFileStoragePort = Readonly<{
  presignUpload(input: Readonly<{ key: string; contentLength: number; expiresInSeconds: number }>): Promise<Readonly<{ url: string; requiredHeaders: Readonly<Record<string, string>>; expiresAt: Date }>>;
  presignDownload(input: Readonly<{ key: string; versionId: string; contentType: string; contentDisposition: string; expiresInSeconds: number }>): Promise<Readonly<{ url: string; expiresAt: Date }>>;
  head(area: CommissionObjectArea, key: string): Promise<Readonly<{ contentLength: number; versionId: string }> | null>;
  open(area: CommissionObjectArea, key: string, versionId: string): Promise<AsyncIterable<Uint8Array>>;
  copyToClean(input: Readonly<{ key: string; sourceVersionId: string; contentType: string }>): Promise<Readonly<{ versionId: string }>>;
  deleteAllVersions(area: CommissionObjectArea, key: string): Promise<number>;
  headBucket(area: CommissionObjectArea): Promise<void>;
}>;
