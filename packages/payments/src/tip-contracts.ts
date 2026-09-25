declare const integerVnd: unique symbol;
export type IntegerVnd = number & { readonly [integerVnd]: true };

export const TIP_ERROR_CODES = [
  "payments_disabled", "policy_changed", "invalid_amount", "invalid_guest_content", "invalid_request",
  "not_available", "not_authorized", "recent_auth_required", "totp_required",
  "rate_limited", "idempotency_conflict", "intent_not_pending", "evidence_mismatch",
  "bank_transaction_conflict", "dependency_unavailable",
] as const;
export type TipErrorCode = (typeof TIP_ERROR_CODES)[number];

export class TipPaymentError extends Error {
  constructor(readonly code: TipErrorCode) {
    super(code);
    this.name = "TipPaymentError";
  }
}

export type TipAmountPolicy = Readonly<{
  minimumVnd: number;
  maximumVnd: number;
  suggestedPresetsVnd: ReadonlyArray<number>;
}>;

/** Domain commands accept numbers only. UI/environment adapters own parsing. */
export function requireIntegerVnd(value: unknown, policy?: Pick<TipAmountPolicy, "minimumVnd" | "maximumVnd">): IntegerVnd {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 ||
    (policy && (!Number.isSafeInteger(policy.minimumVnd) || !Number.isSafeInteger(policy.maximumVnd) ||
      policy.minimumVnd <= 0 || policy.maximumVnd < policy.minimumVnd ||
      value < policy.minimumVnd || value > policy.maximumVnd))) {
    throw new TipPaymentError("invalid_amount");
  }
  return value as IntegerVnd;
}

export type PaymentIntentState = "awaiting_transfer" | "confirmed" | "expired" | "rejected";
export type TipState = "awaiting_payment" | "completed" | "expired" | "rejected";
export type TipSettlementLane = "manual_attested" | "provider_bound";
export type TipConfirmationSource = "creator_manual" | "sepay_automatic" | "creator_reviewed_sepay";
export type TipPaymentPurpose = Readonly<{ kind: "tip"; tipId: string }>;
export type TipPaymentIntent = Readonly<{
  id: string;
  purpose: TipPaymentPurpose;
  creatorUserId: string;
  amountVnd: IntegerVnd;
  currency: "VND";
  transferReference: string;
  receivingAccountVersionId: string;
  state: PaymentIntentState;
  createdAt: Date;
  expiresAt: Date;
}>;
export const TIP_GUEST_NAME_MAX_SCALARS = 80;
export const TIP_GUEST_MESSAGE_MAX_SCALARS = 280;
// A capability is an authorization credential, never a URL or public reference.
export type GuestTipCapability = Readonly<{ secret: string; expiresAt: Date }>;
export type StoredGuestTipCapability = Readonly<{ keyedHash: string; expiresAt: Date }>;
export type TipAccess = Readonly<{ kind: "buyer"; userId: string }> | Readonly<{ kind: "guest"; capability: string }>;
export type TipTransferClaim = Readonly<{ claimedAt: Date; authoritative: false }>;
export type ManualTipConfirmationCommand = Readonly<{
  paymentIntentId: string;
  creatorUserId: string;
  observedAmountVnd: IntegerVnd;
  observedTransferReference: string;
  observedBankTransactionId: string;
  attestedReceived: true;
  idempotencyKey: string;
}>;
export type ManualTipConfirmation = Readonly<{
  paymentIntentId: string;
  creatorUserId: string;
  source: "creator_manual";
  confirmedAt: Date;
  observedAmountVnd: IntegerVnd;
  transferReference: string;
  bankTransactionKeyedFingerprint: string;
}>;
export type TipReceiptProjection = Readonly<{
  reference: string;
  creator: Readonly<{ displayName: string; handle: string }>;
  amountVnd: IntegerVnd;
  currency: "VND";
  state: PaymentIntentState;
  expiresAt: string;
  confirmedAt: string | null;
  transferClaimedAt: string | null;
  settlementLane: TipSettlementLane;
  confirmationSource: TipConfirmationSource | null;
}>;
// This extension is only for a successfully authorized transaction instruction.
// Public creator/directory and ordinary queue projections must not use it.
export type TipInstructionProjection = TipReceiptProjection & Readonly<{
  destination: Readonly<{ bankBin: string; bankName: string; accountNumber: string; accountName: string }>;
  qrPayload: string;
}>;
export type CreatorTipProjection = Readonly<{
  id: string;
  reference: string;
  amountVnd: IntegerVnd;
  state: PaymentIntentState;
  expiresAt: string;
  transferClaimedAt: string | null;
  settlementLane: TipSettlementLane;
  confirmationSource: TipConfirmationSource | null;
}> & (
  | Readonly<{ state: "confirmed"; confirmedAt: string; guestContent: Readonly<{ name: string | null; message: string | null }> }>
  | Readonly<{ state: Exclude<PaymentIntentState, "confirmed">; confirmedAt: null; guestContent?: never }>
);
