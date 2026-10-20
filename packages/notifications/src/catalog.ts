import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CLOCKS,
  NOTIFICATION_KINDS,
  NOTIFICATION_SUBJECT_TYPES,
  NotificationError,
  OPTIONAL_EMAIL_CATEGORIES,
} from "./policy.js";

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
export type OptionalEmailCategory = (typeof OPTIONAL_EMAIL_CATEGORIES)[number];
export type NotificationClock = (typeof NOTIFICATION_CLOCKS)[number];
export type NotificationSubjectType = (typeof NOTIFICATION_SUBJECT_TYPES)[number];

// A notice carries a kind, an optional closed-enum variant and a link. Nothing else is stored or emailed.
export type NoticeDraft = Readonly<{
  recipientUserId: string;
  kind: NotificationKind;
  variant: string | null;
  category: NotificationCategory;
  actionRequired: boolean;
  subjectType: string;
  subjectId: string;
  linkPath: string;
  collapseKey?: string;
  email: "now" | "digest" | "never";
}>;

// Same shape as the database check notifications_variant_check.
export const NOTIFICATION_VARIANT_PATTERN = /^[a-z_]{1,40}$/u;

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const uuidPattern = new RegExp(`^${UUID}$`, "u");
// The database check is `^/[A-Za-z0-9/_-]{1,200}$` and no `//`; the allowlist below is stricter.
const dbLinkPathPattern = /^\/[A-Za-z0-9/_-]{1,200}$/u;
const allowedLinkPatterns: readonly RegExp[] = [
  new RegExp(`^/commissions/${UUID}$`, "u"),
  new RegExp(`^/creator/commissions/${UUID}$`, "u"),
  new RegExp(`^/admin/cases/${UUID}$`, "u"),
  /^\/help\/cases$/u,
  /^\/creator\/tips$/u,
  /^\/creator\/apply$/u,
  /^\/creator$/u,
];

function requireId(id: string): string {
  if (typeof id !== "string" || !uuidPattern.test(id)) throw new NotificationError("invalid_request");
  return id;
}

export function orderLink(role: "buyer" | "creator", orderId: string): string {
  return role === "creator" ? `/creator/commissions/${requireId(orderId)}` : `/commissions/${requireId(orderId)}`;
}

export function caseLink(caseId: string): string {
  return `/admin/cases/${requireId(caseId)}`;
}

export function isNotificationLinkPath(value: string): boolean {
  return typeof value === "string" && dbLinkPathPattern.test(value) && !value.includes("//")
    && allowedLinkPatterns.some((pattern) => pattern.test(value));
}

export function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === "string" && (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === "string" && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}
