import { createManualPaymentConfirmationService, type ConfirmManualPaymentCommand } from "./manual-payment-service.js";
import { createCommissionPaymentIntentPort, type CommissionPaymentProjection } from "./commission-intent-port.js";
import { readPaymentPurpose, type CommissionPaymentLifecyclePort } from "./payment-purpose.js";
import { TipPaymentError } from "./tip-contracts.js";

type SharedInput = Parameters<typeof createManualPaymentConfirmationService<CommissionPaymentProjection>>[0];
type Input = Omit<SharedInput, "purpose" | "lockAggregate" | "completeAggregate" | "project"> & {
  commissions: CommissionPaymentLifecyclePort;
};
export type ConfirmCreatorCommissionCommand = ConfirmManualPaymentCommand;

export function createCreatorCommissionPaymentService(input: Input) {
  const payments = createCommissionPaymentIntentPort(input);
  return createManualPaymentConfirmationService<CommissionPaymentProjection>({ ...input, purpose: "commission",
    lockAggregate: (tx, intent, at) => {
      const purpose = readPaymentPurpose(intent);
      return purpose?.kind === "commission" ? input.commissions.lockSettlement(tx, { orderId: purpose.orderId, creatorUserId: intent.creatorUserId, at }) : Promise.resolve(false);
    },
    completeAggregate: (tx, { intent, actor, at, requestId }) => {
      const purpose = readPaymentPurpose(intent);
      return purpose?.kind === "commission" ? input.commissions.confirmPayment(tx, { orderId: purpose.orderId, paymentIntentId: intent.id,
        creatorUserId: intent.creatorUserId, amountVnd: intent.amountVnd, actor, at, requestId }) : Promise.resolve(false);
    },
    project: async (tx, intent, at) => {
      const purpose = readPaymentPurpose(intent);
      if (purpose?.kind !== "commission") throw new TipPaymentError("not_authorized");
      const payment = await payments.projectPayment(tx, { orderId: purpose.orderId, creatorUserId: intent.creatorUserId, at, includeInstructions: false });
      if (!payment) throw new TipPaymentError("not_available");
      return payment;
    },
  });
}
