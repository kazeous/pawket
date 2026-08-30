export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_SOURCE_PIXELS = 40_000_000;
export const UPLOAD_INTENT_LIFETIME_MS = 15 * 60_000;
export const CREATOR_SOURCE_ALLOCATION_BYTES = 500 * 1024 * 1024;
export const MEDIA_VARIANTS = ["master", "thumb", "display", "large"] as const;
export const SOURCE_FORMATS = ["jpeg", "png", "webp"] as const;
export const MEDIA_PURPOSES = ["avatar", "cover", "showcase"] as const;

export type MediaVariant = (typeof MEDIA_VARIANTS)[number];
export type SourceFormat = (typeof SOURCE_FORMATS)[number];
export type MediaPurpose = (typeof MEDIA_PURPOSES)[number];

export const DERIVATIVE_MAX_BYTES: Readonly<Record<MediaVariant, number>> = {
  master: MAX_SOURCE_BYTES,
  thumb: 512 * 1024,
  display: 3 * 1024 * 1024,
  large: 6 * 1024 * 1024,
};

export class MediaPolicyError extends Error {
  constructor(readonly code: MediaErrorCode) {
    super(code);
    this.name = "MediaPolicyError";
  }
}

export type MediaErrorCode =
  | "INVALID_INPUT"
  | "MEDIA_NOT_FOUND"
  | "MEDIA_NOT_READY"
  | "MEDIA_NOT_OWNER"
  | "MEDIA_WRONG_PURPOSE"
  | "MEDIA_QUOTA_EXCEEDED"
  | "UPLOAD_EXPIRED"
  | "UPLOAD_NOT_READY"
  | "UPLOAD_CONTENT_INVALID"
  | "IDEMPOTENCY_CONFLICT"
  | "PUBLISHING_DISABLED"
  | "STORAGE_UNAVAILABLE"
  | "STORAGE_ERROR";

export function isSourceFormat(value: unknown): value is SourceFormat {
  return typeof value === "string" && (SOURCE_FORMATS as readonly string[]).includes(value);
}

export function isMediaPurpose(value: unknown): value is MediaPurpose {
  return typeof value === "string" && (MEDIA_PURPOSES as readonly string[]).includes(value);
}

export function isMediaVariant(value: unknown): value is MediaVariant {
  return typeof value === "string" && (MEDIA_VARIANTS as readonly string[]).includes(value);
}

export function sourceFormatForContentType(contentType: string): SourceFormat | null {
  if (contentType === "image/jpeg") return "jpeg";
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return null;
}

const UNICODE_WHITESPACE = /\p{White_Space}/u;
const UNICODE_CONTROL = /\p{Cc}/u;
const BIDI_CONTROL = /\p{Bidi_Control}/u;

function isNoncharacter(codePoint: number): boolean {
  return (codePoint >= 0xfdd0 && codePoint <= 0xfdef) || (codePoint & 0xffff) >= 0xfffe;
}

function hasUnsafeUnicode(value: string, rejectWhitespace: boolean): boolean {
  if ((rejectWhitespace && UNICODE_WHITESPACE.test(value)) || UNICODE_CONTROL.test(value) || BIDI_CONTROL.test(value)) return true;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if ((codePoint >= 0xd800 && codePoint <= 0xdfff) || isNoncharacter(codePoint)) return true;
  }
  return false;
}

export function isOpaqueVersionId(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim() || value.toLowerCase() === "null" || hasUnsafeUnicode(value, true)) return false;
  const length = [...value].length;
  return length >= 1 && length <= 512;
}

export function isRawStorageEtag(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim() || hasUnsafeUnicode(value, false)) return false;
  const length = [...value].length;
  return length >= 1 && length <= 512;
}
