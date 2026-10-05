import { and, eq, inArray, or } from "drizzle-orm";
import { commissionOrders, type PawketDatabase, type PawketTransaction } from "@pawket/database";

import { commissionUuid } from "./policy.js";
import type { CommissionCatalogPort } from "./ports.js";
import { lockCommissionCreator } from "./payment-lifecycle.js";

/** Order facts for the files module (structural CommissionFileOrderAccessPort). */
export function createCommissionFileAccessPort(input: Readonly<{ catalog: Pick<CommissionCatalogPort, "findPackageIdentity"> }>) {
  return {
    async briefPackage(tx: PawketTransaction, command: Readonly<{ packageId: string; actorUserId: string }>) {
      if (!commissionUuid(command.packageId)) return null;
      const row = await input.catalog.findPackageIdentity(tx, command.packageId);
      return row && row.creatorUserId !== command.actorUserId ? { creatorUserId: row.creatorUserId } : null;
    },
    async orderAccess(tx: PawketTransaction, command: Readonly<{ orderId: string; actorUserId: string }>) {
      if (!commissionUuid(command.orderId)) return null;
      const [row] = await tx.select({ buyerUserId: commissionOrders.buyerUserId, state: commissionOrders.state, confirmedAt: commissionOrders.confirmedAt, closedAt: commissionOrders.closedAt })
        .from(commissionOrders).where(and(eq(commissionOrders.id, command.orderId), or(eq(commissionOrders.buyerUserId, command.actorUserId), eq(commissionOrders.creatorUserId, command.actorUserId)))).limit(1);
      return row ? { role: row.buyerUserId === command.actorUserId ? "buyer" as const : "creator" as const, state: row.state, confirmedAt: row.confirmedAt, closedAt: row.closedAt } : null;
    },
    async lockFulfillmentOrder(tx: PawketTransaction, command: Readonly<{ orderId: string; actorUserId: string }>) {
      if (!commissionUuid(command.orderId)) return null;
      // Resolve only the immutable creator identity before taking the domain fence.
      const [identity] = await tx.select({ creatorUserId: commissionOrders.creatorUserId }).from(commissionOrders).where(eq(commissionOrders.id, command.orderId)).limit(1);
      if (!identity) return null;
      await lockCommissionCreator(tx, identity.creatorUserId);
      const [row] = await tx.select({ buyerUserId: commissionOrders.buyerUserId, creatorUserId: commissionOrders.creatorUserId, state: commissionOrders.state })
        .from(commissionOrders).where(and(eq(commissionOrders.id, command.orderId), or(eq(commissionOrders.buyerUserId, command.actorUserId), eq(commissionOrders.creatorUserId, command.actorUserId)))).limit(1);
      return row ? { role: row.buyerUserId === command.actorUserId ? "buyer" as const : "creator" as const, state: row.state, creatorUserId: row.creatorUserId } : null;
    },
    retentionFacts: readCommissionFileRetentionFacts,
  };
}

/** Used by the worker's file maintenance, which has no catalog dependency. */
export async function readCommissionFileRetentionFacts(db: PawketDatabase | PawketTransaction, orderIds: readonly string[]) {
  const ids = [...new Set(orderIds)].filter(commissionUuid);
  if (ids.length === 0) return new Map<string, { state: string; confirmedAt: Date | null; closedAt: Date | null; completedAt: Date | null }>();
  const rows = await db.select({ id: commissionOrders.id, state: commissionOrders.state, confirmedAt: commissionOrders.confirmedAt, closedAt: commissionOrders.closedAt, completedAt: commissionOrders.completedAt })
    .from(commissionOrders).where(inArray(commissionOrders.id, ids));
  return new Map(rows.map((row) => [row.id, { state: row.state, confirmedAt: row.confirmedAt, closedAt: row.closedAt, completedAt: row.completedAt }]));
}
