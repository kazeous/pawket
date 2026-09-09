import { isProxy } from "node:util/types";

import type { ReportTarget } from "./trust-ports.js";

export const PUBLIC_REPORT_REASONS = [
  "impersonation",
  "prohibited_or_age_restricted_content",
  "harassment_or_hate",
  "violence_or_self_harm",
  "privacy",
  "intellectual_property",
  "spam_or_scam",
  "other",
] as const;

export type PublicReportReason = (typeof PUBLIC_REPORT_REASONS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NETWORK_HMAC = /^hmac-sha256:v1:[A-Za-z0-9_-]{43}$/u;
const CONTROL = /\p{Cc}/u;
const normalize = String.prototype.normalize;
const charCodeAt = String.prototype.charCodeAt;

export function readExactOwnDataRecord(
  value: unknown,
  allowedShapes: readonly (readonly string[])[],
): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== "object" || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return null;
    const shape = allowedShapes.find((candidate) => candidate.length === keys.length && candidate.every((key) => keys.includes(key)));
    if (!shape) return null;
    const result: Record<string, unknown> = {};
    for (const key of shape) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

export function unicodeCodePointLength(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = Reflect.apply(charCodeAt, value, [index]) as number;
    if (first >= 0xd800 && first <= 0xdbff && index + 1 < value.length) {
      const second = Reflect.apply(charCodeAt, value, [index + 1]) as number;
      if (second >= 0xdc00 && second <= 0xdfff) index += 1;
    }
    count += 1;
  }
  return count;
}

export function normalizeReportReason(value: unknown): PublicReportReason | null {
  return typeof value === "string" && (PUBLIC_REPORT_REASONS as readonly string[]).includes(value)
    ? value as PublicReportReason
    : null;
}

export function normalizeReportDetail(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  try {
    const normalized = Reflect.apply(normalize, value, ["NFC"]) as string;
    if (unicodeCodePointLength(normalized) > 1_000 || CONTROL.test(normalized)) return null;
    return normalized;
  } catch {
    return null;
  }
}

export function normalizeReportTarget(value: unknown): ReportTarget | null {
  const record = readExactOwnDataRecord(value, [["targetType", "targetId", "publicationRevisionId"]]);
  if (!record || (record.targetType !== "page" && record.targetType !== "showcase")
    || typeof record.targetId !== "string" || !UUID.test(record.targetId)
    || typeof record.publicationRevisionId !== "string" || !UUID.test(record.publicationRevisionId)) return null;
  return {
    targetType: record.targetType,
    targetId: record.targetId,
    publicationRevisionId: record.publicationRevisionId,
  };
}

export function validNetworkKeyHmac(value: unknown): value is string {
  return typeof value === "string" && NETWORK_HMAC.test(value);
}

export function validActorUserId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && !CONTROL.test(value);
}

export function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
