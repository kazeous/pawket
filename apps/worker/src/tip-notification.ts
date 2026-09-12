import { randomUUID } from "node:crypto";
import { findEmailHandoffBySourceEvent, findOperationalEmailUser, insertOutboxEvent, type PawketDatabase } from "@pawket/database";
import { queueSecurityEmailHandoff, recordSecurityEmailAttentionRequired } from "@pawket/identity/security-email-handoff";
import { resolveTipNotificationContext, type TipNotificationSource } from "@pawket/payments";
import type { EncryptionKeyring } from "@pawket/security";

export async function materializeTipNotification(input: { db: PawketDatabase; event: TipNotificationSource; keyring: EncryptionKeyring; now: Date }): Promise<"created" | "already_materialized" | "attention_required"> {
  try {
    if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) throw new Error("Invalid notification time");
    return await input.db.transaction(async (tx) => {
      const context = await resolveTipNotificationContext(tx, input.event);
      const existing = await findEmailHandoffBySourceEvent(tx, input.event.outboxEventId);
      if (existing) {
        if (existing.userId !== context.creatorUserId || existing.purpose !== "tip_status") throw new Error("Invalid tip notification");
        return "already_materialized";
      }
      const user = await findOperationalEmailUser(tx, context.creatorUserId); if (!user) throw new Error("Invalid tip notification");
      const templateData = { state: context.state, returnPath: "/creator/tips" };
      const shared = { id: randomUUID(), userId: context.creatorUserId, purpose: "tip_status" as const, sourceOutboxEventId: input.event.outboxEventId, templateData, now: input.now };
      if (user.emailVerified) await queueSecurityEmailHandoff(tx, { ...shared, destination: user.email, keyring: input.keyring });
      else await recordSecurityEmailAttentionRequired(tx, { ...shared, failureCode: "no_verified_destination" });
      // Durable in-app handoff. The existing creator queue/receipt always read
      // business state; delivery or acknowledgement never changes a payment.
      await insertOutboxEvent(tx, { eventType: "tip.notification_available.v1", eventVersion: 1, aggregateType: "tip_notification", aggregateId: input.event.outboxEventId,
        payload: { creatorUserId: context.creatorUserId, paymentIntentId: context.paymentIntentId, state: context.state, returnPath: "/creator/tips", sourceEventId: input.event.outboxEventId }, occurredAt: input.now });
      return user.emailVerified ? "created" : "attention_required";
    });
  } catch { throw new Error("Tip notification handoff failed"); }
}
