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

export const NOTIFICATION_KINDS = [
  "order_requested", "order_quoted", "order_payment_due", "order_transfer_claimed", "order_in_progress",
  "order_delivered", "order_completed", "order_closed", "order_messages", "draft_sent", "draft_responded",
  "proposal_received", "proposal_ended", "dispute_opened", "dispute_statement", "dispute_closed",
  "ruling_recorded", "ruling_corrected", "late_claim_filed", "late_claim_ended", "refund_account_needed",
  "refund_owed", "refund_send_due", "refund_sent", "refund_not_received", "refund_resend_required",
  "refund_settled", "refund_overdue", "content_hidden", "content_restored", "penalty_applied", "penalty_ended",
  "appeal_received", "appeal_decided", "report_received", "report_closed", "owner_case_opened", "tip_status",
  "tip_transfer_claimed", "account_application", "account_creator_status", "account_deposit_refund",
  "reminder_due", "deadline_missed",
] as const;
export const NOTIFICATION_CATEGORIES = ["orders", "messages", "deliveries", "disputes_refunds", "moderation", "owner_queue", "tips", "account"] as const;
export const OPTIONAL_EMAIL_CATEGORIES = ["orders", "messages", "deliveries", "disputes_refunds", "moderation", "owner_queue"] as const;
export const NOTIFICATION_CHANNELS = ["email"] as const;
export const NOTIFICATION_CLOCKS = ["request_response", "quote_acceptance", "payment", "delivery_due", "review_window", "proposal_response", "dispute_response", "late_claim_response", "refund_send", "refund_confirm", "appeal_window"] as const;

export class NotificationError extends Error {
  constructor(readonly code: "not_available" | "invalid_request" | "dependency_unavailable") {
    super(code);
    this.name = "NotificationError";
  }
}
