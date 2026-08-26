import {
  insertOutboxEvent,
  paymentsVerificationDepositRefundObligations,
  vietnamDateFromInstant,
  type PawketDatabase,
} from "@pawket/database";
import { eq, sql } from "drizzle-orm";

export type RefundWindowScanResult = Readonly<{
  dueSoon: number;
  dueToday: number;
  overdue: number;
  attention: number;
  outstandingAmountVnd: number;
}>;

export async function scanVerificationDepositRefundWindows(input: {
  db: PawketDatabase;
  now: Date;
}): Promise<RefundWindowScanResult> {
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    throw new Error("Refund window scan time is invalid");
  }
  const today = vietnamDateFromInstant(input.now);

  return input.db.transaction(async (tx) => {
    const obligations = await tx
      .select()
      .from(paymentsVerificationDepositRefundObligations)
      .where(sql`${paymentsVerificationDepositRefundObligations.state} <> 'sent'`)
      .for("update", { skipLocked: true });

    const result = {
      dueSoon: 0,
      dueToday: 0,
      overdue: 0,
      attention: 0,
      outstandingAmountVnd: 0,
    };
    for (const obligation of obligations) {
      result.outstandingAmountVnd += obligation.amountVnd;
      if (obligation.state === "attention_required") result.attention += 1;
      const category =
        today > obligation.refundDue
          ? "overdue"
          : today === obligation.refundDue
            ? "dueToday"
            : today >= obligation.refundNotBefore
              ? "dueSoon"
              : null;
      if (!category) continue;
      result[category] += 1;

      const marker =
        category === "overdue"
          ? obligation.overdueEmittedAt
          : category === "dueToday"
            ? obligation.dueTodayEmittedAt
            : obligation.dueSoonEmittedAt;
      const nextState =
        category === "overdue" ? "attention_required" : obligation.state === "pending_window" ? "ready" : obligation.state;
      const attentionReason =
        category === "overdue" ? obligation.attentionReason ?? "refund_overdue" : obligation.attentionReason;

      await tx
        .update(paymentsVerificationDepositRefundObligations)
        .set({
          state: nextState,
          attentionReason,
          ...(category === "overdue" && !marker ? { overdueEmittedAt: input.now } : {}),
          ...(category === "dueToday" && !marker ? { dueTodayEmittedAt: input.now } : {}),
          ...(category === "dueSoon" && !marker ? { dueSoonEmittedAt: input.now } : {}),
          updatedAt: input.now,
        })
        .where(eq(paymentsVerificationDepositRefundObligations.id, obligation.id));

      if (!marker) {
        const eventSuffix =
          category === "overdue" ? "overdue" : category === "dueToday" ? "due_today" : "due_soon";
        await insertOutboxEvent(tx, {
          eventType: `payments.verification_deposit_refund_${eventSuffix}.v1`,
          eventVersion: 1,
          aggregateType: "verification_deposit_refund_obligation",
          aggregateId: obligation.id,
          payload: {
            obligationId: obligation.id,
            applicantUserId: obligation.applicantUserId,
            state: nextState,
            amountVnd: obligation.amountVnd,
            refundNotBefore: obligation.refundNotBefore,
            refundDue: obligation.refundDue,
            window: eventSuffix,
            correlationId: obligation.challengeId,
          },
          occurredAt: input.now,
        });
      }
    }
    return result;
  });
}
