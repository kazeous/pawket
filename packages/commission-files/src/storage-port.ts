export type CommissionObjectArea = "quarantine" | "clean";
export class CommissionFileStorageError extends Error {
  constructor(readonly code: "invalid_input" | "unavailable") { super(code); this.name = "CommissionFileStorageError"; }
}
/**
 * `destroy()` must synchronously tear the underlying resource down (a Node Readable's own
 * method) rather than rely on an awaited iterator `.return()`: a stream's async iterator queues
 * `.return()` behind any already-pending `.next()`, so if the consumer abandons a read mid-stream
 * (a scanner timeout, a size-limit abort, ...) awaiting that close can hang forever against a
 * stalled or slow source. `destroy()` unblocks any pending read on its own and never needs to be
 * awaited by the caller.
 */
export type CommissionFileReadStream = AsyncIterable<Uint8Array> & { destroy(): void };
export type CommissionFileStoragePort = Readonly<{
  presignUpload(input: Readonly<{ key: string; contentLength: number; expiresInSeconds: number }>): Promise<Readonly<{ url: string; requiredHeaders: Readonly<Record<string, string>>; expiresAt: Date }>>;
  presignDownload(input: Readonly<{ key: string; versionId: string; contentType: string; contentDisposition: string; expiresInSeconds: number }>): Promise<Readonly<{ url: string; expiresAt: Date }>>;
  head(area: CommissionObjectArea, key: string): Promise<Readonly<{ contentLength: number; versionId: string }> | null>;
  open(area: CommissionObjectArea, key: string, versionId: string): Promise<CommissionFileReadStream>;
  copyToClean(input: Readonly<{ key: string; sourceVersionId: string; contentType: string }>): Promise<Readonly<{ versionId: string }>>;
  deleteAllVersions(area: CommissionObjectArea, key: string): Promise<number>;
  headBucket(area: CommissionObjectArea): Promise<void>;
}>;
