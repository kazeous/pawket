const MIB = 1024 * 1024;
const HOUR_MS = 3_600_000;

export const COMMISSION_FILE_POLICY = Object.freeze({
  briefFileMaxBytes: 25 * MIB, maxBriefFiles: 10, maxUnsentReferences: 10, maxPendingPerActor: 10,
  uploadGrantMs: 15 * 60_000, downloadGrantSeconds: 300, scanDeadlineMs: 24 * HOUR_MS, signatureMaxAgeMs: 24 * HOUR_MS,
  unsentTtlMs: 24 * HOUR_MS, closedUnpaidRetentionMs: 30 * 24 * HOUR_MS, inlinePreviewMaxBytes: 25 * MIB,
  scanLeaseMs: 10 * 60_000, retryBaseMs: 60_000, retryMaxMs: 30 * 60_000, filenameMaxBytes: 255,
});
export const COMMISSION_FILE_TYPES = ["jpeg", "png", "webp", "gif", "pdf"] as const;
export type CommissionFileType = typeof COMMISSION_FILE_TYPES[number];
export const COMMISSION_FILE_CONTEXTS = ["brief"] as const;
export type CommissionFileContext = typeof COMMISSION_FILE_CONTEXTS[number];
export const COMMISSION_FILE_CONTENT_TYPES: Readonly<Record<CommissionFileType, string>> = Object.freeze({
  jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", pdf: "application/pdf",
});
export const COMMISSION_FILE_CONTEXT_TYPES: Readonly<Record<CommissionFileContext, readonly CommissionFileType[]>> = Object.freeze({
  brief: Object.freeze(["jpeg", "png", "webp", "gif", "pdf"] as const),
});
const PREVIEW_TYPES: readonly CommissionFileType[] = ["jpeg", "png", "webp", "gif"];

export const COMMISSION_FILE_ERRORS = [
  "invalid_request", "not_available", "not_authorized", "files_disabled", "file_too_large", "pending_limit", "unsent_limit",
  "upload_expired", "invalid_state", "idempotency_conflict", "preview_not_allowed", "storage_unavailable", "dependency_unavailable",
] as const;
export type CommissionFileErrorCode = typeof COMMISSION_FILE_ERRORS[number];
export class CommissionFileError extends Error {
  constructor(readonly code: CommissionFileErrorCode) { super(code); this.name = "CommissionFileError"; }
}
export function commissionFileFail(code: CommissionFileErrorCode): never { throw new CommissionFileError(code); }

export const commissionFileUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
export const isCommissionFileSha256 = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
export function commissionFileObjectKey(fileId: string): string {
  if (!commissionFileUuid(fileId)) commissionFileFail("invalid_request");
  return `commission/${fileId}`;
}

/** Display-only name. Never used as a storage key or a path. */
export function normalizeCommissionFileName(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096) commissionFileFail("invalid_request");
  let name = value.normalize("NFC").replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/[\\/]/gu, "_").replace(/\s+/gu, " ").trim().replace(/^\.+/u, "").trim();
  if (!name) commissionFileFail("invalid_request");
  const encoder = new TextEncoder();
  while (encoder.encode(name).byteLength > COMMISSION_FILE_POLICY.filenameMaxBytes) name = [...name].slice(0, -1).join("");
  name = name.trim();
  if (!name) commissionFileFail("invalid_request");
  return name;
}

/** RFC 6266 value with an ASCII fallback and an RFC 5987 UTF-8 parameter. */
export function commissionFileContentDisposition(name: string, disposition: "attachment" | "inline"): string {
  const safe = normalizeCommissionFileName(name);
  const fallback = safe.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\%;]/gu, "_");
  const encoded = encodeURIComponent(safe).replace(/['()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function isInlinePreviewAllowed(type: CommissionFileType, bytes: number): boolean {
  return PREVIEW_TYPES.includes(type) && Number.isSafeInteger(bytes) && bytes > 0 && bytes <= COMMISSION_FILE_POLICY.inlinePreviewMaxBytes;
}

export function commissionFileRetryDelayMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts, 1) - 1, 16);
  return Math.min(COMMISSION_FILE_POLICY.retryMaxMs, COMMISSION_FILE_POLICY.retryBaseMs * 2 ** exponent);
}
