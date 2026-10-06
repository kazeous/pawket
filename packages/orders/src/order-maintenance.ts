import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, lte } from "drizzle-orm";
import { commissionOrders, type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { CommissionError, commissionFail, type CommissionCloseReason } from "./contracts.js";
import { commissionIdentifier, commissionInteger, commissionTime, commissionUuid } from "./policy.js";
import { lockCommissionCreator } from "./payment-lifecycle.js";
import { commissionExpiredReason, createCommissionOrderPersistence } from "./order-persistence.js";
import type { CommissionCompletionHoldPort, CommissionIdentityPort, CommissionPaymentsPort } from "./ports.js";
import { readCommissionOperationalReport } from "./order-operations.js";
import { createCommissionFulfillmentMaintenance } from "./fulfillment-maintenance.js";

/** No intake/confirmation mode gates: cleanup must continue through emergency pauses. */
export function createCommissionOrderMaintenanceService(input: {
  db: PawketDatabase; applicationRevision: string; now?: () => Date; idFactory?: () => string;
  identity: Pick<CommissionIdentityPort, "lockSettlementParticipants">;
  trust: { lockCommissionPage(tx: PawketTransaction, creatorUserId: string): Promise<boolean> };
  payments: Pick<CommissionPaymentsPort, "closeIntent" | "hasCurrentDestination">;
  holds?: CommissionCompletionHoldPort;
}) {
  if (!commissionIdentifier(input.applicationRevision)) commissionFail("invalid_request");
  const now = () => { const at = (input.now ?? (() => new Date()))(); commissionTime(at); return new Date(at); };
  const newId = () => { const id = (input.idFactory ?? randomUUID)(); if (!commissionUuid(id)) commissionFail("dependency_unavailable"); return id; };
  const { closeOrder, completeCommissionOrder } = createCommissionOrderPersistence({ ...input, newId });
  async function boundary<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) { if (error instanceof CommissionError) throw error; return commissionFail("dependency_unavailable"); }
  }
  return {
    ...createCommissionFulfillmentMaintenance({ boundary, now, newId, completeCommissionOrder }, input),
    readOperationalReport: () => boundary(() => readCommissionOperationalReport(input.db, now())),
    async expireDue(limit = 100) {
      commissionInteger(limit, 1, 500);
      return boundary(async () => {
        const candidates = await input.db.select({ id: commissionOrders.id, creatorUserId: commissionOrders.creatorUserId }).from(commissionOrders)
          .where(and(inArray(commissionOrders.state, ["requested", "quoted", "awaiting_payment"]), lte(commissionOrders.expiresAt, now())))
          .orderBy(asc(commissionOrders.expiresAt), asc(commissionOrders.id)).limit(limit);
        let expired = 0;
        for (const candidate of candidates) expired += await input.db.transaction(async (tx) => {
          await lockCommissionCreator(tx, candidate.creatorUserId);
          const [order] = await tx.select().from(commissionOrders).where(eq(commissionOrders.id, candidate.id)).limit(1);
          const at = now(); if (!order || !order.expiresAt || order.expiresAt > at || !["requested", "quoted", "awaiting_payment"].includes(order.state)) return 0;
          await closeOrder(tx, order, commissionExpiredReason(order.state), null, `commission-expiry:${newId()}`, at); return 1;
        });
        return { scanned: candidates.length, expired };
      });
    },
    async recoverInvalidations(command: { limit?: number; afterId?: string | null } = {}) {
      const limit = commissionInteger(command.limit ?? 100, 1, 500);
      if (command.afterId != null && !commissionUuid(command.afterId)) commissionFail("invalid_request");
      return boundary(async () => {
        const candidates = await input.db.select({ id: commissionOrders.id, creatorUserId: commissionOrders.creatorUserId }).from(commissionOrders)
          .where(and(inArray(commissionOrders.state, ["requested", "quoted", "awaiting_payment"]), command.afterId ? gt(commissionOrders.id, command.afterId) : undefined))
          .orderBy(asc(commissionOrders.id)).limit(limit);
        let invalidated = 0; let deferred = 0;
        for (const candidate of candidates) {
          try { invalidated += await input.db.transaction(async (tx) => {
            await lockCommissionCreator(tx, candidate.creatorUserId);
            const [order] = await tx.select().from(commissionOrders).where(eq(commissionOrders.id, candidate.id)).limit(1);
            if (!order || !["requested", "quoted", "awaiting_payment"].includes(order.state)) return 0;
            const at = now(); let reason: CommissionCloseReason | null = null;
            if (order.expiresAt && order.expiresAt <= at) reason = commissionExpiredReason(order.state);
            else if (!await input.identity.lockSettlementParticipants(tx, { creatorUserId: order.creatorUserId, buyerUserId: order.buyerUserId, at }) ||
              !await input.trust.lockCommissionPage(tx, order.creatorUserId)) reason = "security_invalidated";
            else if (order.acceptedAt && !await input.payments.hasCurrentDestination(tx, { orderId: order.id, creatorUserId: order.creatorUserId, at })) reason = "eligibility_invalidated";
            if (!reason) return 0;
            const closedAt = now(); if (order.expiresAt && order.expiresAt <= closedAt) reason = commissionExpiredReason(order.state);
            await closeOrder(tx, order, reason, null, `commission-invalidation:${newId()}`, closedAt); return 1;
          }); } catch (error) {
            // A busy fence is unknown, never proof of ineligibility. Move the scan
            // cursor forward and revisit after wraparound to avoid starving others.
            if (error instanceof Error && ["CommissionEligibilityBusyError", "PaymentAccountChangedError"].includes(error.name)) deferred++;
            else throw error;
          }
        }
        return { scanned: candidates.length, invalidated, deferred, nextAfterId: candidates.length === limit ? candidates.at(-1)!.id : null };
      });
    },
  };
}
export type CommissionOrderMaintenanceService = ReturnType<typeof createCommissionOrderMaintenanceService>;
