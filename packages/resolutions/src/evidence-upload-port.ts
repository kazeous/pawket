import { eq } from "drizzle-orm";
import { commissionLatePaymentClaims, type PawketTransaction } from "@pawket/database";
import { commissionIdentifier, commissionTime, commissionUuid } from "@pawket/orders";

import { effectiveResolutionDeadline } from "./deadlines.js";
import { isLatePaymentOrder } from "./late-claim-service.js";
import { RESOLUTION_POLICY } from "./policy.js";
import type { ResolutionOrderPort, ResolutionPaymentFactsPort, ResolutionRefundPort } from "./ports.js";

/** Structural CommissionEvidenceUploadPort; all cross-module facts come through domain ports. */
export function createCommissionEvidenceUploadPort(input: Readonly<{ orders: Pick<ResolutionOrderPort, "lockOrder">;
  refunds: Pick<ResolutionRefundPort, "listForOrder">; payments: Pick<ResolutionPaymentFactsPort, "closedIntent">;
  mode: "disabled" | "enabled"; now?(): Date }>) {
  const now = input.now ?? (() => new Date());
  return {
    async canUpload(tx: PawketTransaction, command: Readonly<{ orderId: string; actorUserId: string }>): Promise<boolean> {
      if (input.mode !== "enabled" || !commissionUuid(command.orderId) || !commissionIdentifier(command.actorUserId)) return false;
      const order = await input.orders.lockOrder(tx, command.orderId); if (!order) return false;
      if (order.creatorUserId === command.actorUserId) {
        const obligations = await input.refunds.listForOrder(tx, { orderId: order.id });
        return obligations.some((obligation) => obligation.state === "awaiting_send");
      }
      if (order.buyerUserId !== command.actorUserId || !isLatePaymentOrder(order) || !await input.payments.closedIntent(tx, order.id)) return false;
      const [claim] = await tx.select({ id: commissionLatePaymentClaims.id }).from(commissionLatePaymentClaims).where(eq(commissionLatePaymentClaims.orderId, order.id)).limit(1);
      if (claim) return false;
      const at = new Date(commissionTime(now()));
      const until = await effectiveResolutionDeadline(tx, new Date(order.closedAt!.getTime() + RESOLUTION_POLICY.claimWindowMs));
      return until !== null && at >= order.closedAt! && at <= until;
    },
  };
}
