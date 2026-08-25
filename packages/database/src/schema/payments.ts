import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires this extensionless TypeScript schema import.
// @ts-ignore Drizzle Kit 0.31 resolves this TypeScript schema only without the emitted .js suffix.
import { identityUsers } from "./identity-core";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires this extensionless TypeScript schema import.
// @ts-ignore Drizzle Kit 0.31 resolves this TypeScript schema only without the emitted .js suffix.
import { creatorApplicationRevisions, creatorApplications } from "./creator-applications";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires this extensionless TypeScript schema import.
// @ts-ignore Drizzle Kit 0.31 resolves this TypeScript schema only without the emitted .js suffix.
import { systemBusinessCalendarVersions } from "./shared-controls";

type Envelope = {
  version: 1;
  algorithm: "A256GCM";
  keyId: string;
  nonce: string;
  ciphertext: string;
  authenticationTag: string;
};

export const paymentsReceivingAccountOnboarding = pgTable(
  "payments_receiving_account_onboarding",
  {
    id: uuid("id").primaryKey(),
    onboardingId: uuid("onboarding_id").notNull(),
    applicantUserId: text("applicant_user_id")
      .notNull()
      .references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
    version: integer("version").notNull(),
    bankBin: text("bank_bin").notNull(),
    bankName: text("bank_name").notNull(),
    accountNumberEnvelope: jsonb("account_number_envelope").$type<Envelope | null>(),
    accountHolderLabelEnvelope: jsonb("account_holder_label_envelope")
      .$type<Envelope | null>(),
    maskedSuffix: text("masked_suffix").notNull(),
    accountFingerprint: text("account_fingerprint").notNull(),
    proofState: text("proof_state").notNull().default("unverified"),
    proofVerifiedAt: timestamp("proof_verified_at", { withTimezone: true, mode: "date" }),
    retiredAt: timestamp("retired_at", { withTimezone: true, mode: "date" }),
    minimizedAt: timestamp("minimized_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("payments_receiving_account_lineage_version_uidx").on(
      table.onboardingId,
      table.version,
    ),
    uniqueIndex("payments_receiving_account_current_applicant_uidx")
      .on(table.applicantUserId)
      .where(sql`${table.retiredAt} is null`),
    index("payments_receiving_account_applicant_idx").on(
      table.applicantUserId,
      table.createdAt,
    ),
    index("payments_receiving_account_fingerprint_idx").on(table.accountFingerprint),
    check("payments_receiving_account_version_check", sql`${table.version} > 0`),
    check("payments_receiving_account_bank_bin_check", sql`${table.bankBin} ~ '^\\d{6}$'`),
    check(
      "payments_receiving_account_mask_check",
      sql`${table.maskedSuffix} ~ '^•••• [0-9]{4}$'`,
    ),
    check(
      "payments_receiving_account_fingerprint_check",
      sql`${table.accountFingerprint} ~ '^hmac-sha256:v1:[A-Za-z0-9_-]{43}$'`,
    ),
    check(
      "payments_receiving_account_proof_state_check",
      sql`${table.proofState} in ('unverified', 'challenge_issued', 'sent_reported', 'verified')`,
    ),
    check(
      "payments_receiving_account_proof_time_check",
      sql`(${table.proofState} = 'verified' and ${table.proofVerifiedAt} is not null)
        or (${table.proofState} <> 'verified' and ${table.proofVerifiedAt} is null)`,
    ),
    check(
      "payments_receiving_account_retired_check",
      sql`${table.retiredAt} is null or ${table.retiredAt} >= ${table.createdAt}`,
    ),
    check(
      "payments_receiving_account_minimized_check",
      sql`(${table.minimizedAt} is null and ${table.accountNumberEnvelope} is not null and ${table.accountHolderLabelEnvelope} is not null)
        or (${table.minimizedAt} is not null and ${table.accountNumberEnvelope} is null and ${table.accountHolderLabelEnvelope} is null)`,
    ),
  ],
);

export const paymentsVerificationDepositChallenges = pgTable(
  "payments_verification_deposit_challenges",
  {
    id: uuid("id").primaryKey(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => creatorApplications.id, { onDelete: "restrict", onUpdate: "restrict" }),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => creatorApplicationRevisions.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    accountVersionId: uuid("account_version_id")
      .notNull()
      .references(() => paymentsReceivingAccountOnboarding.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    amountVnd: integer("amount_vnd").notNull(),
    referenceHash: text("reference_hash").notNull(),
    state: text("state").notNull().default("issued"),
    issuedByOwnerUserId: text("issued_by_owner_user_id")
      .notNull()
      .references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
    stepUpProofId: uuid("step_up_proof_id").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "date" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("payments_deposit_challenge_reference_uidx").on(table.referenceHash),
    uniqueIndex("payments_deposit_challenge_active_revision_uidx")
      .on(table.revisionId, table.accountVersionId)
      .where(sql`${table.state} in ('issued', 'sent_reported')`),
    index("payments_deposit_challenge_application_idx").on(
      table.applicationId,
      table.createdAt,
    ),
    check(
      "payments_deposit_challenge_amount_check",
      sql`${table.amountVnd} between 1000 and 50000`,
    ),
    check(
      "payments_deposit_challenge_reference_check",
      sql`${table.referenceHash} ~ '^sha256:v1:[A-Za-z0-9_-]{43}$'`,
    ),
    check(
      "payments_deposit_challenge_state_check",
      sql`${table.state} in ('issued', 'sent_reported', 'verified', 'expired')`,
    ),
    check(
      "payments_deposit_challenge_expiry_check",
      sql`${table.expiresAt} = ${table.issuedAt} + interval '72 hours'`,
    ),
    check(
      "payments_deposit_challenge_verified_check",
      sql`(${table.state} = 'verified' and ${table.verifiedAt} is not null)
        or (${table.state} <> 'verified' and ${table.verifiedAt} is null)`,
    ),
  ],
);

export const paymentsVerificationDepositReports = pgTable(
  "payments_verification_deposit_reports",
  {
    id: uuid("id").primaryKey(),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => paymentsVerificationDepositChallenges.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    applicantUserId: text("applicant_user_id")
      .notNull()
      .references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
    reportedSentAt: timestamp("reported_sent_at", { withTimezone: true, mode: "date" }).notNull(),
    reportedAt: timestamp("reported_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("payments_deposit_report_challenge_uidx").on(table.challengeId),
    index("payments_deposit_report_applicant_idx").on(table.applicantUserId, table.reportedAt),
  ],
);

export const paymentsVerificationDepositReceipts = pgTable(
  "payments_verification_deposit_receipts",
  {
    id: uuid("id").primaryKey(),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => paymentsVerificationDepositChallenges.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    bankTransactionFingerprint: text("bank_transaction_fingerprint").notNull(),
    actualAmountVnd: integer("actual_amount_vnd").notNull(),
    actualReferenceHash: text("actual_reference_hash").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull(),
    sourceBankBin: text("source_bank_bin").notNull(),
    sourceAccountFingerprint: text("source_account_fingerprint").notNull(),
    sourceMaskedSuffix: text("source_masked_suffix").notNull(),
    privateNote: text("private_note").notNull(),
    result: text("result").notNull().default("matched"),
    reconciledByOwnerUserId: text("reconciled_by_owner_user_id")
      .notNull()
      .references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
    ownerSessionId: text("owner_session_id").notNull(),
    stepUpProofId: uuid("step_up_proof_id").notNull(),
    requestId: text("request_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("payments_deposit_receipt_challenge_uidx").on(table.challengeId),
    uniqueIndex("payments_deposit_receipt_bank_txn_uidx").on(table.bankTransactionFingerprint),
    check("payments_deposit_receipt_amount_check", sql`${table.actualAmountVnd} > 0`),
    check(
      "payments_deposit_receipt_result_check",
      sql`${table.result} = 'matched'`,
    ),
  ],
);

export const paymentsVerificationDepositRefundObligations = pgTable(
  "payments_verification_deposit_refund_obligations",
  {
    id: uuid("id").primaryKey(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => paymentsVerificationDepositReceipts.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => paymentsVerificationDepositChallenges.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    accountVersionId: uuid("account_version_id")
      .notNull()
      .references(() => paymentsReceivingAccountOnboarding.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    applicantUserId: text("applicant_user_id")
      .notNull()
      .references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
    amountVnd: integer("amount_vnd").notNull(),
    lockedBankBin: text("locked_bank_bin").notNull(),
    lockedBankName: text("locked_bank_name").notNull(),
    lockedAccountNumberEnvelope: jsonb("locked_account_number_envelope")
      .$type<Envelope>()
      .notNull(),
    lockedAccountHolderLabelEnvelope: jsonb("locked_account_holder_label_envelope")
      .$type<Envelope>()
      .notNull(),
    lockedMaskedSuffix: text("locked_masked_suffix").notNull(),
    lockedAccountFingerprint: text("locked_account_fingerprint").notNull(),
    calendarVersion: text("calendar_version")
      .notNull()
      .references(() => systemBusinessCalendarVersions.version, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    receiptDate: date("receipt_date", { mode: "string" }).notNull(),
    refundNotBefore: date("refund_not_before", { mode: "string" }).notNull(),
    refundDue: date("refund_due", { mode: "string" }).notNull(),
    state: text("state").notNull().default("pending_window"),
    attentionReason: text("attention_reason"),
    dueSoonEmittedAt: timestamp("due_soon_emitted_at", { withTimezone: true, mode: "date" }),
    dueTodayEmittedAt: timestamp("due_today_emitted_at", { withTimezone: true, mode: "date" }),
    overdueEmittedAt: timestamp("overdue_emitted_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("payments_refund_obligation_receipt_uidx").on(table.receiptId),
    uniqueIndex("payments_refund_obligation_challenge_uidx").on(table.challengeId),
    index("payments_refund_obligation_state_due_idx").on(table.state, table.refundDue),
    index("payments_refund_obligation_applicant_idx").on(table.applicantUserId, table.createdAt),
    check("payments_refund_obligation_amount_check", sql`${table.amountVnd} > 0`),
    check(
      "payments_refund_obligation_window_check",
      sql`${table.refundNotBefore} > ${table.receiptDate} and ${table.refundDue} >= ${table.refundNotBefore}`,
    ),
    check(
      "payments_refund_obligation_state_check",
      sql`${table.state} in ('pending_window', 'ready', 'sent', 'attention_required')`,
    ),
    check(
      "payments_refund_obligation_attention_check",
      sql`(${table.state} = 'attention_required' and ${table.attentionReason} is not null)
        or (${table.state} <> 'attention_required' and ${table.attentionReason} is null)`,
    ),
  ],
);

export const paymentsVerificationDepositRefunds = pgTable(
  "payments_verification_deposit_refunds",
  {
    id: uuid("id").primaryKey(),
    obligationId: uuid("obligation_id")
      .notNull()
      .references(() => paymentsVerificationDepositRefundObligations.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    outcome: text("outcome").notNull(),
    actualAmountVnd: integer("actual_amount_vnd"),
    outboundBankReferenceFingerprint: text("outbound_bank_reference_fingerprint"),
    outboundBankReferenceMasked: text("outbound_bank_reference_masked"),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    attentionReason: text("attention_reason"),
    recordedByOwnerUserId: text("recorded_by_owner_user_id")
      .notNull()
      .references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
    ownerSessionId: text("owner_session_id").notNull(),
    stepUpProofId: uuid("step_up_proof_id").notNull(),
    requestId: text("request_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("payments_refund_sent_obligation_uidx")
      .on(table.obligationId)
      .where(sql`${table.outcome} = 'sent'`),
    uniqueIndex("payments_refund_outbound_reference_uidx")
      .on(table.outboundBankReferenceFingerprint)
      .where(sql`${table.outboundBankReferenceFingerprint} is not null`),
    index("payments_refund_obligation_idx").on(table.obligationId, table.createdAt),
    check(
      "payments_refund_outcome_check",
      sql`${table.outcome} in ('sent', 'attention_required')`,
    ),
    check(
      "payments_refund_evidence_check",
      sql`(${table.outcome} = 'sent' and ${table.actualAmountVnd} > 0
            and ${table.outboundBankReferenceFingerprint} is not null
            and ${table.outboundBankReferenceMasked} is not null and ${table.sentAt} is not null
            and ${table.attentionReason} is null)
        or (${table.outcome} = 'attention_required' and ${table.sentAt} is null
            and ${table.actualAmountVnd} is null and ${table.attentionReason} is not null)`,
    ),
  ],
);

export const paymentsUnmatchedDeposits = pgTable(
  "payments_unmatched_deposits",
  {
    id: uuid("id").primaryKey(),
    possibleChallengeId: uuid("possible_challenge_id").references(
      () => paymentsVerificationDepositChallenges.id,
      { onDelete: "restrict", onUpdate: "restrict" },
    ),
    bankTransactionFingerprint: text("bank_transaction_fingerprint").notNull(),
    actualAmountVnd: integer("actual_amount_vnd").notNull(),
    actualReferenceHash: text("actual_reference_hash").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull(),
    sourceBankBin: text("source_bank_bin"),
    sourceAccountFingerprint: text("source_account_fingerprint"),
    sourceMaskedSuffix: text("source_masked_suffix"),
    reason: text("reason").notNull(),
    resolutionState: text("resolution_state").notNull().default("pending_review"),
    refundLiabilityState: text("refund_liability_state").notNull(),
    privateNote: text("private_note").notNull(),
    reconciledByOwnerUserId: text("reconciled_by_owner_user_id")
      .notNull()
      .references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
    ownerSessionId: text("owner_session_id").notNull(),
    stepUpProofId: uuid("step_up_proof_id").notNull(),
    requestId: text("request_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    index("payments_unmatched_resolution_idx").on(table.resolutionState, table.createdAt),
    index("payments_unmatched_bank_txn_idx").on(table.bankTransactionFingerprint),
    check("payments_unmatched_amount_check", sql`${table.actualAmountVnd} > 0`),
    check(
      "payments_unmatched_reason_check",
      sql`${table.reason} in ('amount_mismatch', 'reference_mismatch', 'source_mismatch', 'unidentified_source', 'late', 'duplicate')`,
    ),
    check(
      "payments_unmatched_resolution_check",
      sql`${table.resolutionState} in ('pending_review', 'refund_required', 'resolved')`,
    ),
    check(
      "payments_unmatched_liability_check",
      sql`${table.refundLiabilityState} in ('unknown', 'pending', 'sent', 'attention_required')`,
    ),
  ],
);
