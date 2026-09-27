import { types as nodeTypes } from "node:util";
import { commissionFail, type CommissionBrief, type CommissionTerms } from "./contracts.js";

const DAY_MS = 86_400_000;
export const COMMISSION_POLICY = Object.freeze({
  version: "commission-v1",
  minimumVnd: 50_000, maximumVnd: 50_000_000,
  minimumTurnaroundDays: 1, maximumTurnaroundDays: 90,
  maximumRevisionAllowance: 10,
  defaultReviewWindowDays: 7, minimumReviewWindowDays: 3, maximumReviewWindowDays: 14,
  defaultCapacity: 3, minimumCapacity: 1, maximumCapacity: 20,
  maximumPackages: 12, maximumOpenPairOrders: 3,
  requestTtlMs: 7 * DAY_MS, defaultQuoteTtlMs: 7 * DAY_MS,
  minimumQuoteTtlMs: 3_600_000, maximumQuoteTtlMs: 14 * DAY_MS, requestMaximumAgeMs: 30 * DAY_MS,
  paymentTtlMs: DAY_MS, maximumBriefCodePoints: 3_000,
  maximumLinks: 5, maximumLinkBytes: 512, maximumPlaintextBytes: 16_384,
});

export const commissionUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
export const commissionIdentifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
export const commissionIdempotencyKey = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._-]{8,200}$/u.test(value);

/** Reject accessors/proxies instead of evaluating user-supplied object behavior. */
export function readCommissionRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  if (Reflect.ownKeys(value).length !== keys.length) return null;
  const fields = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const field = fields[key];
    if (!field || !field.enumerable || !("value" in field)) return null;
    result[key] = field.value;
  }
  return result;
}

export function commissionText(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string") commissionFail("invalid_request");
  const text = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  if ([...text].length < minimum || [...text].length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069<>]/u.test(text) ||
    /\p{Cs}/u.test(text) || Buffer.byteLength(JSON.stringify(text), "utf8") > COMMISSION_POLICY.maximumPlaintextBytes) commissionFail("invalid_request");
  return text;
}

export function commissionInteger(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) commissionFail("invalid_request");
  return value;
}

export function normalizeCommissionBrief(value: unknown): CommissionBrief {
  const record = readCommissionRecord(value, ["text", "referenceLinks"]);
  if (!record) commissionFail("invalid_brief");
  try {
    const text = commissionText(record.text, 1, COMMISSION_POLICY.maximumBriefCodePoints);
    const links = record.referenceLinks;
    if (!Array.isArray(links) || nodeTypes.isProxy(links) || Object.getPrototypeOf(links) !== Array.prototype ||
      links.length > COMMISSION_POLICY.maximumLinks || Reflect.ownKeys(links).length !== links.length + 1) commissionFail("invalid_brief");
    const descriptors = Object.getOwnPropertyDescriptors(links);
    const referenceLinks: string[] = [];
    for (let index = 0; index < links.length; index++) {
      const field = descriptors[String(index)];
      if (!field || !field.enumerable || !("value" in field)) commissionFail("invalid_brief");
      const raw: unknown = field.value;
      if (typeof raw !== "string" || raw !== raw.trim() || !/^https:\/\/[^/?#]+/iu.test(raw) ||
        /[\p{Cc}\p{Cs}\s]/u.test(raw) || Buffer.byteLength(raw) > COMMISSION_POLICY.maximumLinkBytes) commissionFail("invalid_brief");
      const url = new URL(raw);
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password || Buffer.byteLength(url.href) > COMMISSION_POLICY.maximumLinkBytes) commissionFail("invalid_brief");
      referenceLinks.push(url.href);
    }
    if (new Set(referenceLinks).size !== referenceLinks.length || Buffer.byteLength(JSON.stringify(referenceLinks)) > COMMISSION_POLICY.maximumPlaintextBytes) commissionFail("invalid_brief");
    return Object.freeze({ text, referenceLinks: Object.freeze(referenceLinks) });
  } catch { return commissionFail("invalid_brief"); }
}

export function normalizeCommissionTerms(value: unknown): CommissionTerms {
  const record = readCommissionRecord(value, ["amountVnd", "turnaroundDays", "revisionAllowance", "reviewWindowDays", "scope", "deliverables", "usageRights", "artistTerms", "policyRevisionId"]);
  if (!record || !commissionUuid(record.policyRevisionId)) commissionFail("invalid_terms");
  try {
    return Object.freeze({
      amountVnd: commissionInteger(record.amountVnd, COMMISSION_POLICY.minimumVnd, COMMISSION_POLICY.maximumVnd),
      turnaroundDays: commissionInteger(record.turnaroundDays, 1, 90),
      revisionAllowance: commissionInteger(record.revisionAllowance, 0, 10),
      reviewWindowDays: commissionInteger(record.reviewWindowDays, 3, 14),
      scope: commissionText(record.scope, 1, 2_000),
      deliverables: commissionText(record.deliverables, 1, 2_000),
      usageRights: commissionText(record.usageRights, 1, 2_000),
      artistTerms: commissionText(record.artistTerms, 1, 2_000),
      policyRevisionId: record.policyRevisionId,
    });
  } catch { return commissionFail("invalid_terms"); }
}

export function commissionTime(value: Date): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) commissionFail("invalid_request");
  return value.getTime();
}
function plus(value: Date, delta: number): Date {
  const result = new Date(commissionTime(value) + delta);
  commissionTime(result);
  return result;
}
export function commissionQuoteExpiry(requestCreatedAt: Date, issuedAt: Date, ttlMs: number): Date {
  commissionInteger(ttlMs, COMMISSION_POLICY.minimumQuoteTtlMs, COMMISSION_POLICY.maximumQuoteTtlMs);
  if (commissionTime(issuedAt) < commissionTime(requestCreatedAt)) commissionFail("invalid_request");
  const expiresAt = new Date(Math.min(plus(issuedAt, ttlMs).getTime(), plus(requestCreatedAt, COMMISSION_POLICY.requestMaximumAgeMs).getTime()));
  if (expiresAt.getTime() - issuedAt.getTime() < COMMISSION_POLICY.minimumQuoteTtlMs) commissionFail("expired");
  return expiresAt;
}
export const commissionPaymentExpiry = (acceptedAt: Date): Date => plus(acceptedAt, COMMISSION_POLICY.paymentTtlMs);
export const commissionRequestExpiry = (createdAt: Date): Date => plus(createdAt, COMMISSION_POLICY.requestTtlMs);
export const commissionDueAt = (confirmedAt: Date, turnaroundDays: number): Date => plus(confirmedAt, commissionInteger(turnaroundDays, 1, 90) * DAY_MS);
export function requireCommissionBeforeDeadline(at: Date, expiresAt: Date): void {
  if (commissionTime(at) >= commissionTime(expiresAt)) commissionFail("expired");
}
