import { describe, expect, test } from "vitest";
import * as database from "@pawket/database";
import {
  NOTIFICATION_POLICY, NOTIFICATION_KINDS, NOTIFICATION_CATEGORIES, OPTIONAL_EMAIL_CATEGORIES,
  NOTIFICATION_CHANNELS, NOTIFICATION_CLOCKS, NOTIFICATION_SUBJECT_TYPES,
} from "../src/index.js";

describe("notification policy contract", () => {
  test("pins the frozen notification policy values", () => {
    expect(NOTIFICATION_POLICY).toEqual({
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
    expect(Object.isFrozen(NOTIFICATION_POLICY)).toBe(true);
  });
  test("pins the shared notification kinds and category/channel/clock lists", () => {
    expect(NOTIFICATION_KINDS).toHaveLength(44);
    expect(new Set(NOTIFICATION_KINDS).size).toBe(44);
    expect(NOTIFICATION_CATEGORIES).toEqual(["orders", "messages", "deliveries", "disputes_refunds", "moderation", "owner_queue", "tips", "account"]);
    expect(OPTIONAL_EMAIL_CATEGORIES).toEqual(["orders", "messages", "deliveries", "disputes_refunds", "moderation", "owner_queue"]);
    expect(NOTIFICATION_CHANNELS).toEqual(["email"]);
    expect(NOTIFICATION_CLOCKS).toEqual(["request_response", "quote_acceptance", "payment", "delivery_due", "review_window", "proposal_response", "dispute_response", "late_claim_response", "refund_send", "refund_confirm", "appeal_window"]);
    expect(NOTIFICATION_SUBJECT_TYPES).toEqual(["commission_order", "commission_proposal", "commission_dispute", "commission_late_payment_claim",
      "commission_refund_obligation", "trust_case", "trust_content_hide", "trust_penalty", "trust_appeal", "trust_report",
      "tip", "creator_application", "creator_capability", "verification_deposit"]);
  });
  test("re-exports the database-owned enum constants through the notifications package", () => {
    expect(NOTIFICATION_KINDS).toBe(database.NOTIFICATION_KINDS);
    expect(NOTIFICATION_CATEGORIES).toBe(database.NOTIFICATION_CATEGORIES);
    expect(OPTIONAL_EMAIL_CATEGORIES).toBe(database.OPTIONAL_EMAIL_CATEGORIES);
    expect(NOTIFICATION_CHANNELS).toBe(database.NOTIFICATION_CHANNELS);
    expect(NOTIFICATION_CLOCKS).toBe(database.NOTIFICATION_CLOCKS);
    expect(NOTIFICATION_SUBJECT_TYPES).toBe(database.NOTIFICATION_SUBJECT_TYPES);
  });
});
