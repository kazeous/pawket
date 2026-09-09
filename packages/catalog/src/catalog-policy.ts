export const DISCIPLINES = [
  "illustration", "drawing", "painting", "comics", "animation", "three_d",
  "graphic_design", "photography", "crafts", "other",
] as const;

export type Discipline = (typeof DISCIPLINES)[number];

export const TAXONOMY_VERSION = "creator-discipline-v1";
export const CONTENT_POLICY_VERSION = "general-audience-v1";

export const RESERVED_HANDLES = new Set([
  "admin", "api", "assets", "auth", "creator", "creators", "favicon", "forgot-password",
  "health", "legal", "media", "metrics", "pawket", "privacy", "reset-password", "robots",
  "security", "settings", "sign-in", "sign-up", "sitemap", "static", "support", "terms",
  "verify-email", "_next",
]);

export class CatalogPolicyError extends Error {
  constructor(readonly reason: string) {
    super("Creator catalog does not meet policy");
  }
}

export type ProfileTextBounds = Readonly<{
  minCodePoints: number;
  maxCodePoints: number;
}>;

const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CONTROL_CHARACTER = /\p{Cc}/u;
const BIDI_CONTROL_CHARACTER = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const HTML_ANGLE_BRACKET = /[<>]/u;
const EXPLICIT_HTTPS_AUTHORITY = /^https:\/\/[^/?#]+/iu;

function reject(reason: string): never {
  throw new CatalogPolicyError(reason);
}

export function normalizeHandle(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 30 ||
    !HANDLE.test(value) ||
    RESERVED_HANDLES.has(value)
  ) {
    return reject("invalid_handle");
  }
  return value;
}

export function normalizeProfileText(value: unknown, bounds: ProfileTextBounds): string {
  if (
    typeof value !== "string" ||
    !Number.isInteger(bounds.minCodePoints) ||
    !Number.isInteger(bounds.maxCodePoints) ||
    bounds.minCodePoints < 0 ||
    bounds.maxCodePoints < bounds.minCodePoints
  ) {
    return reject("invalid_profile_text");
  }
  const normalized = value.normalize("NFC");
  const length = [...normalized].length;
  if (
    length < bounds.minCodePoints ||
    length > bounds.maxCodePoints ||
    CONTROL_CHARACTER.test(normalized) ||
    BIDI_CONTROL_CHARACTER.test(normalized) ||
    HTML_ANGLE_BRACKET.test(normalized)
  ) {
    return reject("invalid_profile_text");
  }
  return normalized;
}

export function normalizeExternalDestination(value: unknown): string {
  if (typeof value !== "string" || !EXPLICIT_HTTPS_AUTHORITY.test(value)) {
    return reject("invalid_external_destination");
  }
  let destination: URL;
  try {
    destination = new URL(value);
  } catch {
    return reject("invalid_external_destination");
  }
  if (
    destination.protocol !== "https:" ||
    !destination.hostname ||
    destination.username ||
    destination.password
  ) {
    return reject("invalid_external_destination");
  }
  return destination.href;
}
