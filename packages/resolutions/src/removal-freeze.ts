import { insertOutboxEvent, type PawketTransaction } from "@pawket/database";
import { resolutionFail, type ResolutionActor } from "./contracts.js";
import type { ResolutionCasePort, ResolutionOrderPort, ResolutionPaymentFactsPort, ResolutionRefundPort } from "./ports.js";
import { closeSuspendedPaidOrder } from "./suspension-service.js";

type ExitPorts = Readonly<{ orders: ResolutionOrderPort; refunds: ResolutionRefundPort; payments: ResolutionPaymentFactsPort; cases: ResolutionCasePort }>;
/** The enforcement caller holds the creator fence and identity locks. Stage A's owner freeze is unchanged. */
export function createRemovalFreezePort(input: ExitPorts & { mode: "disabled" | "enabled" }) {
  if (input.mode !== "enabled" && input.mode !== "disabled") resolutionFail("invalid_request");
  return {
    async freezeForRemoval(tx: PawketTransaction, command: { creatorUserId: string; actor: ResolutionActor; requestId: string; at: Date }): Promise<{ closedOrders: number }> {
      const candidates = await input.orders.listLiveOrders(tx, command.creatorUserId);
      if (candidates.length > 0 && input.mode !== "enabled") resolutionFail("resolution_disabled");
      for (const candidate of candidates) {
        const facts = await input.orders.lockOrder(tx, candidate.orderId);
        if (!facts || facts.creatorUserId !== command.creatorUserId || !["in_progress", "delivered"].includes(facts.state) || facts.version !== candidate.version) resolutionFail("version_conflict");
        await closeSuspendedPaidOrder(tx, input, facts, { reason: "fulfillment_frozen", actor: command.actor, requestId: command.requestId, at: command.at });
      }
      const closedOrders = candidates.length;
      if (closedOrders > 0) await insertOutboxEvent(tx, { eventType: "resolution.fulfillment_frozen.v1", eventVersion: 1, aggregateType: "creator", aggregateId: command.creatorUserId,
        payload: { creatorUserId: command.creatorUserId, closedOrders }, occurredAt: command.at });
      return { closedOrders };
    },
  };
}
export type RemovalFreezePort = ReturnType<typeof createRemovalFreezePort>;
