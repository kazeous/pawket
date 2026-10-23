export {
  NOTIFICATION_POLICY,
  NOTIFICATION_KINDS,
  NOTIFICATION_CATEGORIES,
  OPTIONAL_EMAIL_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_CLOCKS,
  NOTIFICATION_SUBJECT_TYPES,
  NotificationError,
  type NotificationsMode,
  type NotificationSourceEvent,
} from "./policy.js";
export {
  NOTIFICATION_VARIANT_PATTERN,
  caseLink,
  isNotificationCategory,
  isNotificationKind,
  isNotificationLinkPath,
  orderLink,
  type NoticeDraft,
  type NotificationCategory,
  type NotificationClock,
  type NotificationKind,
  type NotificationSubjectType,
  type OptionalEmailCategory,
} from "./catalog.js";
export { NOTIFICATION_EMAIL_COPY, renderNotice, subjectForCategory, type NoticeText } from "./copy.js";
export { NOTIFICATION_SOURCE_EVENTS, createNotificationMaterializer } from "./materializer.js";
export { resolveNotices, type CommittedOutboxRow } from "./recipients.js";
export type { NotificationDeadlinePort, NotificationEmailPort } from "./ports.js";
export { createNotificationMaintenance, type NotificationMaintenanceFailure, type NotificationMaintenanceResult } from "./maintenance.js";
export { APPEAL_WINDOW_MS, CLOCK_CATEGORIES, readOpenClocks, reminderStage, type ClockRecipient, type OpenClock, type ReminderStage } from "./clocks.js";
export { createNotificationInbox, markNotificationsRead, type InboxItem, type MarkReadTarget, type NotificationInbox } from "./inbox-service.js";
