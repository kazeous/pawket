import { createHash, randomUUID } from "node:crypto";
import { types as nodeTypes } from "node:util";
import { and, eq } from "drizzle-orm";
import { commissionLatePaymentClaims, insertOutboxEvent, type PawketTransaction } from "@pawket/database";
import { commissionIdentifier, commissionTime, commissionUuid, readCommissionRecord, type CommissionResolutionOrderFacts } from "@pawket/orders";
import { resolutionFail, type ResolutionActor, type ResolutionCommand } from "./contracts.js";
import type { createResolutionCommandKit } from "./command-kit.js";
import { effectiveResolutionDeadline } from "./deadlines.js";
import { normalizeResolutionText, RESOLUTION_POLICY } from "./policy.js";
import type { ResolutionOrderPort, ResolutionRefundPort, ResolutionPaymentFactsPort, ResolutionCasePort } from "./ports.js";

export type CommissionLatePaymentClaim = typeof commissionLatePaymentClaims.$inferSelect;
/** Structural copy of Payments' CommissionRefundFilesPort; Task 14 supplies the implementation. */
type CommissionRefundFilesPort = Readonly<{
  attachResolutionEvidence(tx: PawketTransaction, command: Readonly<{ orderId: string; ownerUserId: string;
    target: { kind: "refund_send" | "late_claim"; id: string }; fileIds: readonly string[]; at: Date }>): Promise<"attached" | "invalid" | "disabled">;
}>;
type Kit = ReturnType<typeof createResolutionCommandKit>;
type Input = Readonly<{ orders: ResolutionOrderPort; refunds: ResolutionRefundPort; payments: ResolutionPaymentFactsPort;
  cases: ResolutionCasePort; files?: CommissionRefundFilesPort; mode: "disabled" | "enabled" }>;
type File = ResolutionCommand & Readonly<{ orderId: string; transferAt: Date; amountVnd: number; bankReference: string; note?: string; fileIds?: readonly string[] }>;
type Answer = ResolutionCommand & Readonly<{ claimId: string; received: boolean; receivedAmountVnd?: number }>;
type Provider = Readonly<{ orderId: string; paymentIntentId: string; amountVnd: number; providerEventId: string; at: Date; requestId: string }>;
export type LateClaimView = Readonly<{ id: string; state: string; transferAt: string; claimedAmountVnd: number; bankReference: string; note: string | null;
  creatorRespondBy: string | null; receivedAmountVnd: number | null; filedAt: string; endedAt: string | null }>;
const commandKeys = ["actor", "idempotencyKey", "requestId"];
function exact(command: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (!command || typeof command !== "object" || nodeTypes.isProxy(command) || Object.getPrototypeOf(command) !== Object.prototype) resolutionFail("invalid_request");
  const keys = Reflect.ownKeys(command);
  if (keys.some((key) => typeof key !== "string" || ![...commandKeys, ...required, ...optional].includes(key))
    || !readCommissionRecord(command, keys as string[]) || [...commandKeys, ...required].some((key) => !Object.hasOwn(command, key))) resolutionFail("invalid_request");
}
export const lateClaimAmountValid = (value: unknown): value is number => Number.isSafeInteger(value) && typeof value === "number" && value >= 1 && value <= RESOLUTION_POLICY.maxClaimAmountVnd;
function resultId(reference: string) { if (!commissionUuid(reference)) resolutionFail("dependency_unavailable"); return reference; }
function evidenceIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 3
    || Reflect.ownKeys(value).length !== value.length + 1) resolutionFail("invalid_request");
  const descriptors = Object.getOwnPropertyDescriptors(value); const ids: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const field = descriptors[String(index)];
    if (!field || !field.enumerable || !("value" in field) || !commissionUuid(field.value)) resolutionFail("invalid_request"); ids.push(field.value);
  }
  if (new Set(ids).size !== ids.length) resolutionFail("invalid_request"); return Object.freeze(ids);
}
/** Expired/rejected intent facts distinguish awaiting_payment closes from requested/quoted closes. */
export function isLatePaymentOrder(order: CommissionResolutionOrderFacts): boolean {
  return order.state === "closed" && order.confirmedAt === null && order.acceptedAt !== null && order.closedAt !== null
    && ["payment_expired", "buyer_cancelled", "creator_cancelled", "security_invalidated", "eligibility_invalidated"].includes(order.closeReason ?? "");
}
export async function readLatePaymentClaim(tx: PawketTransaction, claimId: string, locked = false): Promise<CommissionLatePaymentClaim> {
  const query = tx.select().from(commissionLatePaymentClaims).where(eq(commissionLatePaymentClaims.id, claimId)).limit(1);
  const [row] = await (locked ? query.for("update") : query); if (!row) resolutionFail("not_available"); return row;
}
/** Internal transition helper; callers hold the creator/order fence and the claim row lock. */
export async function recordLateClaimState(tx: PawketTransaction, row: CommissionLatePaymentClaim, state: "escalated" | "refund_owed" | "rejected",
  amountVnd: number | null, at: Date) {
  const [changed] = await tx.update(commissionLatePaymentClaims).set({ state, receivedAmountVnd: amountVnd, endedAt: state === "escalated" ? null : at, version: row.version + 1 })
    .where(and(eq(commissionLatePaymentClaims.id, row.id), eq(commissionLatePaymentClaims.version, row.version), eq(commissionLatePaymentClaims.state, row.state))).returning();
  if (!changed) resolutionFail("version_conflict");
  await insertOutboxEvent(tx, { eventType: "resolution.late_claim_ended.v1", eventVersion: 1, aggregateType: "commission_late_payment_claim", aggregateId: row.id,
    payload: { claimId: row.id, orderId: row.orderId, state }, occurredAt: at });
}
// SePay webhook event IDs are canonical decimal strings (not UUIDs). Preserve UUID fixture IDs;
// otherwise use RFC 9562 UUIDv5 (SHA-1, URL namespace) over "pawket:sepay:late-payment:" + event ID.
// The namespace and prefix are permanent: changing either would break source idempotency.
function providerSourceId(eventId: string): string {
  if (commissionUuid(eventId)) return eventId.toLowerCase();
  if (typeof eventId !== "string" || !/^[1-9][0-9]{0,31}$/u.test(eventId)) resolutionFail("invalid_request");
  const bytes = createHash("sha1").update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"))
    .update(`pawket:sepay:late-payment:${eventId}`, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createLateClaimService(kit: Kit, input: Input) {
  if (input.mode !== "enabled" && input.mode !== "disabled") resolutionFail("invalid_request");
  const enabled = () => { if (input.mode !== "enabled") resolutionFail("resolution_disabled"); };
  async function owned(tx: PawketTransaction, orderId: string, actor: ResolutionActor, role: "buyer" | "creator") {
    const order = await input.orders.lockOrder(tx, orderId);
    if (!order || (role === "buyer" ? order.buyerUserId : order.creatorUserId) !== actor.userId) resolutionFail("not_available"); return order;
  }
  async function closedIntent(tx: PawketTransaction, order: CommissionResolutionOrderFacts) {
    if (!isLatePaymentOrder(order)) resolutionFail("invalid_transition");
    const intent = await input.payments.closedIntent(tx, order.id); if (!intent) resolutionFail("invalid_transition"); return intent;
  }
  async function escalate(tx: PawketTransaction, row: CommissionLatePaymentClaim, order: CommissionResolutionOrderFacts, at: Date, requestId: string) {
    await recordLateClaimState(tx, row, "escalated", null, at);
    await input.cases.openCase(tx, { kind: "late_payment", orderId: order.id, sourceType: "commission_late_payment_claim", sourceId: row.id,
      policyRevisionId: order.policyRevisionId, requestId, at });
  }
  return {
    async fileLateClaim(command: File): Promise<{ claimId: string }> {
      enabled(); exact(command, ["orderId", "transferAt", "amountVnd", "bankReference"], ["note", "fileIds"]);
      if (!commissionUuid(command.orderId) || !lateClaimAmountValid(command.amountVnd)) resolutionFail("invalid_request"); commissionTime(command.transferAt);
      if (typeof command.bankReference !== "string") resolutionFail("invalid_request"); const bankReference = command.bankReference.trim();
      // Same normalization contract as Payments' normalizeBankReference, without a sibling dependency.
      if (!/^[A-Za-z0-9._/-]{1,64}$/u.test(bankReference)) resolutionFail("invalid_request");
      const note = command.note === undefined ? null : normalizeResolutionText(command.note, 0, RESOLUTION_POLICY.noteMaxCodePoints) || null;
      if (Object.hasOwn(command, "fileIds") && !input.files) resolutionFail("invalid_request");
      const fileIds = Object.hasOwn(command, "fileIds") ? evidenceIds(command.fileIds) : [];
      const reference = await kit.mutate(command, "file_late_claim", [command.orderId, command.transferAt.toISOString(), command.amountVnd, bankReference, note, fileIds],
        async (tx) => (await owned(tx, command.orderId, command.actor, "buyer")).creatorUserId, async (tx) => {
          const order = await owned(tx, command.orderId, command.actor, "buyer"); const at = kit.now(); await closedIntent(tx, order);
          const [existing] = await tx.select({ id: commissionLatePaymentClaims.id }).from(commissionLatePaymentClaims).where(eq(commissionLatePaymentClaims.orderId, order.id)).limit(1);
          if (existing) resolutionFail("invalid_transition");
          if (at < order.closedAt! || command.transferAt > at) resolutionFail("invalid_request");
          const until = await effectiveResolutionDeadline(tx, new Date(order.closedAt!.getTime() + RESOLUTION_POLICY.claimWindowMs));
          if (!until) resolutionFail("resolution_disabled"); if (at > until) resolutionFail("deadline_passed");
          const claimId = randomUUID();
          await tx.insert(commissionLatePaymentClaims).values({ id: claimId, orderId: order.id, buyerUserId: order.buyerUserId, transferAt: command.transferAt,
            claimedAmountVnd: command.amountVnd, referenceEnvelope: kit.encrypt("commission_late_payment_claims", claimId, "bank_reference", bankReference),
            noteEnvelope: note === null ? null : kit.encrypt("commission_late_payment_claims", claimId, "note", note),
            creatorRespondBy: new Date(at.getTime() + RESOLUTION_POLICY.claimResponseMs), filedAt: at });
          if (fileIds.length) {
            const attached = await input.files!.attachResolutionEvidence(tx, { orderId: order.id, ownerUserId: command.actor.userId, target: { kind: "late_claim", id: claimId }, fileIds, at });
            if (attached === "disabled") resolutionFail("resolution_disabled"); if (attached !== "attached") resolutionFail("invalid_request");
          }
          await insertOutboxEvent(tx, { eventType: "resolution.late_claim_filed.v1", eventVersion: 1, aggregateType: "commission_late_payment_claim", aggregateId: claimId,
            payload: { claimId, orderId: order.id }, occurredAt: at });
          return { resultReference: claimId, at, guardUntil: new Date(until.getTime() + 1) };
        });
      return { claimId: resultId(reference) };
    },
    async answerLateClaim(command: Answer): Promise<{ claimId: string }> {
      enabled(); exact(command, ["claimId", "received"], ["receivedAmountVnd"]);
      if (!commissionUuid(command.claimId) || typeof command.received !== "boolean" || (command.received ? !lateClaimAmountValid(command.receivedAmountVnd)
        : Object.hasOwn(command, "receivedAmountVnd"))) resolutionFail("invalid_request");
      const reference = await kit.mutate(command, "answer_late_claim", [command.claimId, command.received, command.receivedAmountVnd ?? null],
        async (tx) => (await owned(tx, (await readLatePaymentClaim(tx, command.claimId)).orderId, command.actor, "creator")).creatorUserId, async (tx) => {
          const row = await readLatePaymentClaim(tx, command.claimId, true); const order = await owned(tx, row.orderId, command.actor, "creator"); const at = kit.now();
          if (row.state !== "awaiting_creator") resolutionFail("invalid_transition"); if (at < row.filedAt) resolutionFail("invalid_request");
          const until = await effectiveResolutionDeadline(tx, row.creatorRespondBy);
          if (!until) resolutionFail("resolution_disabled"); if (at >= until) resolutionFail("deadline_passed");
          const intent = await closedIntent(tx, order);
          if (command.received) {
            await input.refunds.createObligation(tx, { orderId: order.id, paymentIntentId: intent.paymentIntentId, creatorUserId: order.creatorUserId,
              buyerUserId: order.buyerUserId, source: "late_payment", sourceId: row.id, amountVnd: command.receivedAmountVnd!, requestId: command.requestId, at });
            await recordLateClaimState(tx, row, "refund_owed", command.receivedAmountVnd!, at);
          } else await escalate(tx, row, order, at, command.requestId);
          return { resultReference: row.id, at, guardUntil: until };
        });
      return { claimId: resultId(reference) };
    },
    /** Maintenance owns the transaction; refresh under the creator/order fence before checking the effective deadline. */
    async escalateUnanswered(tx: PawketTransaction, candidate: CommissionLatePaymentClaim, at: Date, requestId: string): Promise<void> {
      commissionTime(at); if (!commissionUuid(candidate.id) || !commissionUuid(candidate.orderId) || !commissionIdentifier(requestId)) resolutionFail("invalid_request");
      if (input.mode !== "enabled") return;
      const order = await input.orders.lockOrder(tx, candidate.orderId); if (!order) resolutionFail("not_available");
      const row = await readLatePaymentClaim(tx, candidate.id, true); if (row.orderId !== order.id) resolutionFail("not_available");
      if (row.state !== "awaiting_creator") return; if (at < row.filedAt) resolutionFail("invalid_request");
      const until = await effectiveResolutionDeadline(tx, row.creatorRespondBy); if (!until || at < until) return;
      await closedIntent(tx, order); await escalate(tx, row, order, at, requestId);
    },
    /** Internal verified-provider hook. Matching reference and destination revision are the provider caller's responsibility. */
    async recordProviderLatePayment(tx: PawketTransaction, command: Provider): Promise<"obligation_created" | "already_recorded" | "not_applicable"> {
      if (!readCommissionRecord(command, ["orderId", "paymentIntentId", "amountVnd", "providerEventId", "at", "requestId"]) || !commissionUuid(command.orderId)
        || !commissionUuid(command.paymentIntentId) || !lateClaimAmountValid(command.amountVnd) || !commissionIdentifier(command.requestId)) resolutionFail("invalid_request");
      commissionTime(command.at); const sourceId = providerSourceId(command.providerEventId);
      if (input.mode !== "enabled") return "not_applicable";
      const order = await input.orders.lockOrder(tx, command.orderId); if (!order || !isLatePaymentOrder(order)) return "not_applicable";
      const intent = await input.payments.closedIntent(tx, order.id);
      if (!intent || intent.paymentIntentId !== command.paymentIntentId || intent.amountVnd !== command.amountVnd) return "not_applicable";
      const obligation = await input.refunds.createObligation(tx, { orderId: order.id, paymentIntentId: intent.paymentIntentId, creatorUserId: order.creatorUserId,
        buyerUserId: order.buyerUserId, source: "late_payment_provider", sourceId, amountVnd: command.amountVnd, requestId: command.requestId, at: command.at });
      const [claim] = await tx.select().from(commissionLatePaymentClaims).where(eq(commissionLatePaymentClaims.orderId, order.id)).limit(1).for("update");
      if (claim && ["awaiting_creator", "escalated"].includes(claim.state)) {
        if (command.at < claim.filedAt) resolutionFail("invalid_request");
        await recordLateClaimState(tx, claim, "refund_owed", command.amountVnd, command.at);
        if (claim.state === "escalated") {
          const openCase = await input.cases.findOpenCase(tx, { kind: "late_payment", sourceId: claim.id }); if (!openCase) resolutionFail("dependency_unavailable");
          await input.cases.resolveCase(tx, { caseId: openCase.caseId, resolutionKind: "refund_owed", actor: null, reason: null, requestId: command.requestId, at: command.at });
        }
      }
      return obligation.created ? "obligation_created" : "already_recorded";
    },
    /** Participant view composition calls this inside its authorized, session-checked creator/order transaction. Reads work while disabled. */
    async readForOrder(tx: PawketTransaction, orderId: string): Promise<LateClaimView | null> {
      const [row] = await tx.select().from(commissionLatePaymentClaims).where(eq(commissionLatePaymentClaims.orderId, orderId)).limit(1); if (!row) return null;
      return { id: row.id, state: row.state, transferAt: row.transferAt.toISOString(), claimedAmountVnd: row.claimedAmountVnd,
        bankReference: kit.decrypt("commission_late_payment_claims", row.id, "bank_reference", row.referenceEnvelope),
        note: row.noteEnvelope === null ? null : kit.decrypt("commission_late_payment_claims", row.id, "note", row.noteEnvelope),
        creatorRespondBy: (await effectiveResolutionDeadline(tx, row.creatorRespondBy))?.toISOString() ?? null,
        receivedAmountVnd: row.receivedAmountVnd, filedAt: row.filedAt.toISOString(), endedAt: row.endedAt?.toISOString() ?? null };
    },
  };
}
export type LateClaimService = ReturnType<typeof createLateClaimService>;
