export {
  NOTIFICATION_KINDS, NOTIFICATION_CATEGORIES, OPTIONAL_EMAIL_CATEGORIES, NOTIFICATION_CHANNELS,
  NOTIFICATION_CLOCKS, NOTIFICATION_SUBJECT_TYPES,
} from "@pawket/database";

export type NotificationsMode = "disabled" | "enabled";
export type NotificationSourceEvent = Readonly<{
  outboxEventId: string;
  eventType: string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string;
}>;

export const NOTIFICATION_POLICY = Object.freeze({
  digestDelayMs: 900_000,
  digestSpacingMs: 3_600_000,
  reminderLeadMs: 86_400_000,
  reminderMinimumNoticeMs: 129_600_000,
  retentionMs: 7_776_000_000,
  scanIntervalMs: 60_000,
  scanBatch: 200,
  inboxPageSize: 30,
  unreadCap: 99,
  readBatchMax: 30,
});

export class NotificationError extends Error {
  constructor(readonly code: "not_available" | "invalid_request" | "dependency_unavailable") {
    super(code);
    this.name = "NotificationError";
  }
}
