import type { SePayProviderBinding, SePayProviderCapabilities, SePayProviderTransaction, SePayReadbackResult } from "./sepay-provider.js";
import type { SePayWebhookEvent } from "./sepay-webhook.js";

export type SePayTipMatchIntent = Readonly<{
  settlementLane: "manual_attested" | "provider_bound";
  state: "awaiting_transfer" | "confirmed" | "expired" | "rejected";
  amountVnd: number; transferReference: string; bankBin: string; accountNumber: string;
  createdAt: Date; expiresAt: Date; cutoverAt: Date | null;
}>;
export type SePayMatchReason = "contract_unverified" | "manual_lane" | "intent_not_pending" | "expired" |
  "readback_inconclusive" | "not_found" | "ambiguous" | "identity_mismatch" | "destination_mismatch" |
  "reference_mismatch" | "amount_mismatch" | "direction_mismatch" | "time_mismatch" | "before_cutover" | "invalid_evidence";
export type SePayTipMatch = Readonly<{ kind: "matched"; transaction: SePayProviderTransaction }> |
  Readonly<{ kind: "review"; reason: SePayMatchReason }>;

function sameBinding(left: SePayProviderBinding, right: SePayProviderBinding): boolean {
  return left.environment === right.environment && left.tenantId === right.tenantId && left.accountId === right.accountId &&
    left.bankBin === right.bankBin && left.bankGateway === right.bankGateway && left.accountNumber === right.accountNumber && left.subAccount === right.subAccount;
}
function date(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()); }
function positiveInteger(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function bindingValid(binding: SePayProviderBinding): boolean {
  return (binding.environment === "test" || binding.environment === "live") && /^[A-Za-z0-9._:-]{1,200}$/.test(binding.tenantId) &&
    /^[1-9][0-9]{0,31}$/.test(binding.accountId) && /^[0-9]{6}$/.test(binding.bankBin) &&
    typeof binding.bankGateway === "string" && binding.bankGateway.length > 0 && binding.bankGateway.length <= 80 &&
    typeof binding.accountNumber === "string" && /^[A-Za-z0-9]{1,64}$/.test(binding.accountNumber) &&
    (binding.subAccount === null || (typeof binding.subAccount === "string" && /^[A-Za-z0-9]{1,64}$/.test(binding.subAccount)));
}

/** Pure evidence match only; callers must still hold all current DB/version fences. */
export function matchSePayTip(input: Readonly<{
  intent: SePayTipMatchIntent; binding: SePayProviderBinding; event: SePayWebhookEvent;
  readback: SePayReadbackResult; capabilities: SePayProviderCapabilities; now: Date;
}>): SePayTipMatch {
  const review = (reason: SePayMatchReason): SePayTipMatch => ({ kind: "review", reason });
  const { intent, binding, event, capabilities, readback, now } = input;
  if (!capabilities.oauthApplication || !capabilities.pkceS256 || !capabilities.stableAccountIdentity || !capabilities.canonicalTransactionIdentity || !capabilities.bankTimeReference) return review("contract_unverified");
  if (intent.settlementLane !== "provider_bound") return review("manual_lane");
  if (intent.state !== "awaiting_transfer") return review("intent_not_pending");
  if (!date(now) || !date(intent.createdAt) || !date(intent.expiresAt) || !date(intent.cutoverAt) || !date(event.occurredAt) ||
    !positiveInteger(intent.amountVnd) || !positiveInteger(event.amountVnd) || !bindingValid(binding) ||
    !/^PW[0-9A-F]{20}$/.test(intent.transferReference) || !/^[1-9][0-9]{0,31}$/.test(event.id) ||
    intent.createdAt >= intent.expiresAt || intent.createdAt < intent.cutoverAt) return review("invalid_evidence");
  if (intent.expiresAt <= now) return review("expired");
  if (readback.kind !== "complete") return review("readback_inconclusive");
  if (event.referenceStatus !== "exact" || event.reference !== intent.transferReference) return review("reference_mismatch");
  if (event.amountVnd !== intent.amountVnd) return review("amount_mismatch");
  if (intent.bankBin !== binding.bankBin || intent.accountNumber !== (binding.subAccount ?? binding.accountNumber) ||
    event.bankGateway !== binding.bankGateway || event.accountNumber !== binding.accountNumber || event.subAccount !== binding.subAccount) return review("destination_mismatch");
  const candidates = readback.transactions.filter((row) => row.id === event.id || row.reference === intent.transferReference);
  if (!candidates.length) return review("not_found");
  if (candidates.length !== 1) return review("ambiguous");
  const transaction = candidates[0]!;
  if (transaction.id !== event.id || !sameBinding(transaction.binding, binding)) return review("identity_mismatch");
  if (!date(transaction.occurredAt) || !positiveInteger(transaction.amountVnd)) return review("invalid_evidence");
  if (transaction.direction !== "in") return review("direction_mismatch");
  if (transaction.referenceStatus !== "exact" || transaction.reference !== intent.transferReference) return review("reference_mismatch");
  if (transaction.amountVnd !== intent.amountVnd) return review("amount_mismatch");
  if (transaction.occurredAt.getTime() !== event.occurredAt.getTime() || transaction.bankReference !== event.bankReference ||
    transaction.occurredAt > now || transaction.occurredAt >= intent.expiresAt) return review("time_mismatch");
  if (transaction.occurredAt < intent.cutoverAt || transaction.occurredAt < intent.createdAt) return review("before_cutover");
  return { kind: "matched", transaction };
}
