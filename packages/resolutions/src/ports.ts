import type { PawketDatabase, PawketTransaction } from "@pawket/database";
import type { CommissionResolutionOrderFacts, PostPaymentCloseReason } from "@pawket/orders";
import type { ResolutionActor } from "./contracts.js";

type OrderCommand = Readonly<{ orderId: string; expectedVersion: number; actor: ResolutionActor | null; requestId: string; at: Date }>;
export type ResolutionOrderPort = Readonly<{
  lockOrder(tx: PawketTransaction, orderId: string): Promise<CommissionResolutionOrderFacts | null>;
  closePaidOrder(tx: PawketTransaction, command: OrderCommand & { reason: PostPaymentCloseReason }): Promise<{ version: number }>;
  completeByResolution(tx: PawketTransaction, command: OrderCommand & { kind: "agreement" | "ruling" }): Promise<{ version: number }>;
  restoreReviewTime(tx: PawketTransaction, command: OrderCommand & { floorAt: Date }): Promise<{ version: number }>;
  completionDueAt(tx: PawketTransaction, orderId: string): Promise<Date | null>;
  listLiveOrders(tx: PawketTransaction, creatorUserId: string): Promise<readonly { orderId: string; version: number }[]>;
}>;
type RefundSource = "agreement" | "ruling" | "correction" | "late_payment" | "late_payment_provider" | "suspension_cancel" | "fulfillment_freeze";
type RefundCommand = Readonly<{ obligationId: string; actor: ResolutionActor | null; requestId: string; at: Date }>;
export type ResolutionRefundView = Readonly<{
  obligationId: string; source: string; sourceId: string; amountVnd: number; reference: string; state: string;
  bankBin: string | null; bankName: string | null; suffix: string | null; dueAt: Date | null; confirmBy: Date | null;
  endedAt: Date | null; destinationPurgedAt: Date | null; currentSendId: string | null; hasRecordedSend: boolean; version: number; createdAt: Date;
}>;
/** Payments implements these ports structurally; Resolutions never reads Payments' tables. */
export type ResolutionRefundPort = Readonly<{
  createObligation(tx: PawketTransaction, command: Readonly<{ orderId: string; paymentIntentId: string; creatorUserId: string; buyerUserId: string;
    source: RefundSource; sourceId: string; amountVnd: number; requestId: string; at: Date }>): Promise<{ obligationId: string; created: boolean }>;
  adjustAmount(tx: PawketTransaction, command: RefundCommand & { newAmountVnd: number }): Promise<"adjusted" | "waived" | "recorded_only">;
  waive(tx: PawketTransaction, command: RefundCommand): Promise<void>;
  extendDeadline(tx: PawketTransaction, command: RefundCommand & { until: Date }): Promise<void>;
  acceptReceiptEvidence(tx: PawketTransaction, command: RefundCommand): Promise<void>;
  requireResend(tx: PawketTransaction, command: RefundCommand): Promise<void>;
  awaitingSendDeadlines(tx: PawketTransaction, creatorUserId: string): Promise<readonly { obligationId: string; dueAt: Date }[]>;
  listForOrder(tx: PawketTransaction, command: { orderId: string }): Promise<readonly ResolutionRefundView[]>;
}>;
type CaseKind = "dispute" | "refund_not_received" | "refund_overdue" | "late_payment";
export type ResolutionRefundMaintenancePort = Readonly<{
  readOverdueCandidates(db: PawketDatabase, command: { at: Date; limit: number; after?: RefundCandidateCursor | null }): Promise<readonly { obligationId: string; orderId: string; version: number; dueAt: Date | null }[]>;
  readConfirmationCandidates(db: PawketDatabase, command: { at: Date; limit: number; after?: RefundCandidateCursor | null }): Promise<readonly { obligationId: string; orderId: string; version: number; confirmBy: Date | null }[]>;
  presumeReceived(tx: PawketTransaction, command: { obligationId: string; requestId: string; at: Date }): Promise<void>;
  purgeDestinations(db: PawketDatabase, command: { at: Date; limit: number }): Promise<number>;
}>;
export type RefundCandidateCursor = Readonly<{ deadline: Date; obligationId: string }>;
type CaseCommand = Readonly<{ caseId: string; actor: ResolutionActor | null; reason: string | null; requestId: string; at: Date }>;
export type ResolutionCasePort = Readonly<{
  readCase(tx: PawketTransaction, caseId: string): Promise<Readonly<{ caseId: string; kind: string; orderId: string;
    sourceType: string; sourceId: string; state: string; resolutionKind: string | null; version: number; policyRevisionId: string | null }> | null>;
  openCase(tx: PawketTransaction, command: Readonly<{ kind: CaseKind; orderId: string;
    sourceType: "commission_dispute" | "commission_refund_obligation" | "commission_late_payment_claim";
    sourceId: string; policyRevisionId: string | null; requestId: string; at: Date }>): Promise<{ caseId: string; created: boolean }>;
  resolveCase(tx: PawketTransaction, command: CaseCommand & { resolutionKind: string }): Promise<void>;
  recordCaseEvent(tx: PawketTransaction, command: CaseCommand & { action: "question_posted" | "deadline_extended" }): Promise<void>;
  findOpenCase(tx: PawketTransaction, command: { kind: CaseKind; sourceId: string }): Promise<{ caseId: string; version: number } | null>;
}>;
export type ResolutionPaymentFactsPort = Readonly<{
  paidIntent(tx: PawketTransaction, orderId: string): Promise<{ paymentIntentId: string; amountVnd: number } | null>;
  closedIntent(tx: PawketTransaction, orderId: string): Promise<{ paymentIntentId: string; amountVnd: number } | null>;
}>;
export type ResolutionSessionPort = Readonly<{
  getTipSessionAssurance(tx: PawketTransaction, actor: ResolutionActor, at: Date): Promise<Readonly<{ sessionExpiresAt: Date }> | null>;
}>;
/** Identity holds the capability and user share locks until the resolution transaction commits. */
export type ResolutionStandingPort = Readonly<{
  readCreatorStanding(tx: PawketTransaction, creatorUserId: string): Promise<"active" | "suspended" | "none">;
}>;
