import { and, eq, inArray } from "drizzle-orm";
import { commissionOrders, commissionMessages, commissionFiles, commissionFileAttachments, type PawketTransaction } from "@pawket/database";
import { sql } from "drizzle-orm";
import { commissionFileUuid } from "./file-policy.js";

/** Structural trust port, without importing Trust or introducing a Files -> Orders dependency. */
export function createThreadReportTargetPort() {
  return {
    async resolve(tx: PawketTransaction, target: { kind: string; orderId?: string; messageId?: string; fileId?: string }, reporter: { userId: string } | null) {
      if ((target.kind !== "commission_message" && target.kind !== "commission_file") || !commissionFileUuid(target.orderId) || !reporter) return null;
      const [order] = await tx.select({ creatorUserId: commissionOrders.creatorUserId, buyerUserId: commissionOrders.buyerUserId }).from(commissionOrders)
        .where(eq(commissionOrders.id, target.orderId)).limit(1);
      if (!order || (reporter.userId !== order.creatorUserId && reporter.userId !== order.buyerUserId)) return null;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`commissions:creator:${order.creatorUserId}`}, 0))`);
      const other = reporter.userId === order.creatorUserId ? order.buyerUserId : order.creatorUserId;
      if (target.kind === "commission_message") {
        if (!commissionFileUuid(target.messageId)) return null;
        const [message] = await tx.select({ id: commissionMessages.id }).from(commissionMessages)
          .where(and(eq(commissionMessages.id, target.messageId), eq(commissionMessages.orderId, target.orderId), eq(commissionMessages.authorUserId, other))).limit(1);
        return message ? { kind: "commission_message" as const, targetId: message.id, orderId: target.orderId, contentOwnerUserId: other, packageRevisionId: null } : null;
      }
      if (!commissionFileUuid(target.fileId)) return null;
      const [file] = await tx.select({ id: commissionFiles.id }).from(commissionFiles)
        .innerJoin(commissionFileAttachments, and(eq(commissionFileAttachments.fileId, commissionFiles.id), eq(commissionFileAttachments.orderId, commissionFiles.orderId)))
        .where(and(eq(commissionFiles.id, target.fileId), eq(commissionFiles.orderId, target.orderId), eq(commissionFiles.ownerUserId, other),
          inArray(commissionFiles.context, ["thread", "submission"]), inArray(commissionFileAttachments.targetKind, ["message", "submission"]),
          inArray(commissionFiles.state, ["attached", "deleted"]))).limit(1);
      return file ? { kind: "commission_file" as const, targetId: file.id, orderId: target.orderId, contentOwnerUserId: other, packageRevisionId: null } : null;
    },
  };
}
