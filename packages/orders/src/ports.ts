import type { commissionPackages, commissionPackageRevisions, PawketTransaction } from "@pawket/database";
import type { CommissionActor } from "./contracts.js";
import type { CommissionPolicySnapshot } from "./policy-repository.js";

export type CommissionSessionProof = Readonly<{ sessionExpiresAt: Date }>;
export type CommissionIdentityPort = Readonly<{
  getTipSessionAssurance(tx: PawketTransaction, actor: CommissionActor, at: Date): Promise<CommissionSessionProof | null>;
  lockSettlementParticipants(tx: PawketTransaction, command: { creatorUserId: string; buyerUserId: string; at: Date }): Promise<boolean>;
}>;
export type CommissionIntakePackage = Readonly<{
  package: typeof commissionPackages.$inferSelect; revision: typeof commissionPackageRevisions.$inferSelect;
  creator: { displayName: string; canonicalHandle: string; showcaseId: string | null };
  accountVersionId: string | null; capacityLimit: number; policy: CommissionPolicySnapshot;
}>;
export type CommissionCatalogPort = Readonly<{
  findPackageIdentity(tx: PawketTransaction, packageId: string): Promise<{ creatorUserId: string; route: string } | null>;
  getIntakePackage(tx: PawketTransaction, command: { packageId: string; revisionId: string; allowPreviousRevision: boolean; requirePayment: boolean; at: Date }): Promise<CommissionIntakePackage>;
}>;
export type CommissionPaymentView = Readonly<{
  id: string; orderId: string; amountVnd: number; state: "awaiting_transfer" | "confirmed" | "expired" | "rejected";
  reference: string; expiresAt: string; confirmedAt: string | null; transferClaimedAt: string | null;
  settlementLane: "manual_attested" | "provider_bound"; confirmationSource: "creator_manual" | "sepay_automatic" | "creator_reviewed_sepay" | null;
  destination: { bankBin: string; bankName: string; accountNumber: string; accountName: string };
  instruction: Readonly<{
    reference: string; amountVnd: number; currency: "VND"; expiresAt: string; qrPayload: string;
    creator: { displayName: string; handle: string }; settlementLane: "manual_attested" | "provider_bound";
    destination: { bankBin: string; bankName: string; accountNumber: string; accountName: string };
  }> | null;
}>;
type PaymentBinding = { orderId: string; creatorUserId: string; at: Date };
export type CommissionPaymentsPort = Readonly<{
  hasCurrentDestination(tx: PawketTransaction, command: PaymentBinding): Promise<boolean>;
  createIntent(tx: PawketTransaction, command: PaymentBinding & { accountVersionId: string; amountVnd: number;
    creator: { displayName: string; handle: string }; abuseKeyHash: string; requestId: string }): Promise<{ paymentIntentId: string }>;
  projectPayment(tx: PawketTransaction, command: PaymentBinding & { includeInstructions: boolean }): Promise<CommissionPaymentView | null>;
  closeIntent(tx: PawketTransaction, command: PaymentBinding & { reason: "payment_expired" | "buyer_cancelled" | "creator_cancelled" | "security_invalidated" | "eligibility_invalidated" }): Promise<boolean>;
  claimTransfer(tx: PawketTransaction, command: PaymentBinding & { buyerUserId: string; requestId: string }): Promise<{ claimId: string; claimedAt: Date; created: boolean }>;
}>;
export type CommissionReferenceFileView = Readonly<{
  fileId: string; name: string | null; sizeBytes: number; detectedType: string; sha256: string; previewable: boolean; availability: "available" | "withdrawn" | "deleted";
}>;
/** Implemented structurally by @pawket/commission-files. Orders never reads file tables. */
export type CommissionFilesPort = Readonly<{
  attachBriefFiles(tx: PawketTransaction, command: Readonly<{ orderId: string; buyerUserId: string; packageId: string; fileIds: readonly string[]; at: Date }>): Promise<"attached" | "invalid" | "disabled">;
  describeBriefFiles(tx: PawketTransaction, command: Readonly<{ orderId: string; viewer: "buyer" | "creator"; withdrawn: boolean }>): Promise<readonly CommissionReferenceFileView[]>;
}>;

export type CommissionAttachmentTarget = Readonly<{ kind: "message" | "submission"; id: string }>;
export type CommissionAttachedFileView = Readonly<{
  fileId: string; name: string | null; sizeBytes: number; detectedType: "jpeg" | "png" | "webp" | "gif" | "pdf" | "psd" | "clip" | "zip"; sha256: string;
  previewable: boolean; availability: "available" | "deleted";
}>;
export type CommissionThreadEntry = Readonly<{ sequence: number; kind: "message" | "submission"; entryId: string; createdAt: Date }>;
/** Implemented structurally by @pawket/commission-files. All operations share the caller's transaction. */
export type CommissionThreadPort = Readonly<{
  appendEntry(tx: PawketTransaction, command: Readonly<{ orderId: string; kind: "message" | "submission"; entryId: string; at: Date }>): Promise<number>;
  attachOrderFiles(tx: PawketTransaction, command: Readonly<{ orderId: string; ownerUserId: string; context: "thread" | "submission";
    target: CommissionAttachmentTarget; fileIds: readonly string[]; at: Date }>): Promise<"attached" | "invalid" | "disabled">;
  describeAttachedFiles(tx: PawketTransaction, command: Readonly<{ orderId: string; targets: readonly CommissionAttachmentTarget[] }>): Promise<ReadonlyMap<string, readonly CommissionAttachedFileView[]>>;
  listEntries(tx: PawketTransaction, command: Readonly<{ orderId: string; beforeSequence?: number; limit: number }>): Promise<readonly CommissionThreadEntry[]>;
  describeMessages(tx: PawketTransaction, command: Readonly<{ orderId: string; messageIds: readonly string[] }>): Promise<ReadonlyMap<string, Readonly<{ authorUserId: string; text: string | null; createdAt: Date }>>>;
}>;
export type CommissionCompletionHoldPort = Readonly<{
  hasActiveCompletionHold(tx: PawketTransaction, orderId: string): Promise<boolean>;
  hasOpenDispute(tx: PawketTransaction, orderId: string): Promise<boolean>;
}>;
export const noCommissionCompletionHolds: CommissionCompletionHoldPort = Object.freeze({ hasActiveCompletionHold: async () => false, hasOpenDispute: async () => false });
export type CommissionIntakeFencePort = Readonly<{
  isIntakePaused(tx: PawketTransaction, creatorUserId: string, at: Date): Promise<boolean>;
  describe(tx: PawketTransaction, creatorUserId: string, at: Date): Promise<Readonly<{ paused: boolean; overdue: readonly Readonly<{ obligationId: string; dueAt: string }>[] }>>;
}>;
export const noCommissionIntakeFence: CommissionIntakeFencePort = Object.freeze({ isIntakePaused: async () => false, describe: async () => ({ paused: false, overdue: [] }) });
