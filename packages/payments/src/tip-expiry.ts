import { randomUUID } from "node:crypto";
import { appendAdminAuditEvent, insertOutboxEvent, paymentIntents, type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { and, asc, eq, lte } from "drizzle-orm";
import { TipPaymentError } from "./tip-contracts.js";

export type TipExpiryPort = Readonly<{
  expireTip(tx: PawketTransaction, command: { tipId: string; creatorUserId: string; amountVnd: number; at: Date }): Promise<boolean>;
}>;
export type TipExpiryResult = Readonly<{ scanned: number; expired: number }>;

/** No decryption, network delivery or creator decision occurs in this scan. */
export async function expireTipPaymentIntents(input: Readonly<{
  db: PawketDatabase; tips: TipExpiryPort; paymentsMode: "disabled" | "manual_only";
  batchSize: number; now: Date; applicationRevision: string;
}>): Promise<TipExpiryResult> {
  if (!["disabled", "manual_only"].includes(input.paymentsMode) || !Number.isInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 500 ||
    !(input.now instanceof Date) || !Number.isFinite(input.now.getTime()) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(input.applicationRevision)) throw new TipPaymentError("invalid_request");
  if (input.paymentsMode === "disabled") return { scanned: 0, expired: 0 };
  const at = new Date(input.now); const requestId = randomUUID();
  try {
    return await input.db.transaction(async (tx) => {
      const rows = await tx.select({ id: paymentIntents.id, tipId: paymentIntents.tipId, creatorUserId: paymentIntents.creatorUserId, amountVnd: paymentIntents.amountVnd })
        .from(paymentIntents).where(and(eq(paymentIntents.purpose, "tip"), eq(paymentIntents.state, "awaiting_transfer"), lte(paymentIntents.expiresAt, at)))
        .orderBy(asc(paymentIntents.expiresAt), asc(paymentIntents.id)).limit(input.batchSize).for("update", { skipLocked: true });
      for (const row of rows) {
        const [expired] = await tx.update(paymentIntents).set({ state: "expired", closedAt: at, updatedAt: at }).where(and(eq(paymentIntents.id, row.id), eq(paymentIntents.state, "awaiting_transfer"), lte(paymentIntents.expiresAt, at))).returning({ id: paymentIntents.id });
        if (!expired || await input.tips.expireTip(tx, { tipId: row.tipId, creatorUserId: row.creatorUserId, amountVnd: row.amountVnd, at }) !== true) throw new TipPaymentError("dependency_unavailable");
        await appendAdminAuditEvent(tx, { actorUserId: "system:tip-expiry", subjectType: "payment_intent", subjectId: row.id, action: "tip.expired", outcome: "succeeded",
          beforeState: { state: "awaiting_transfer" }, afterState: { state: "expired" }, assurance: { method: "bounded_expiry_scan" },
          applicationRevision: input.applicationRevision, requestId, occurredAt: at });
        await insertOutboxEvent(tx, { eventType: "tip.expired.v1", eventVersion: 1, aggregateType: "payment_intent", aggregateId: row.id,
          payload: { paymentIntentId: row.id, tipId: row.tipId, creatorUserId: row.creatorUserId, correlationId: requestId }, occurredAt: at });
      }
      return { scanned: rows.length, expired: rows.length };
    });
  } catch { throw new TipPaymentError("dependency_unavailable"); }
}
