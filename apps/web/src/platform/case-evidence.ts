import type { CommissionFileService } from "@pawket/commission-files";
import type { CommissionOrderService } from "@pawket/orders";
import type { CommissionRefundPort } from "@pawket/payments";
import type { createResolutionViewService } from "@pawket/resolutions";
import { TrustCaseError, type TrustCaseEvidencePort } from "@pawket/trust";

type Input = Readonly<{
  orders: Pick<CommissionOrderService, "readOrderForCase" | "readThreadForCase">;
  refunds: Pick<CommissionRefundPort, "listForOrder" | "revealForCase">;
  view: Pick<ReturnType<typeof createResolutionViewService>, "readForCase">;
  files: Pick<CommissionFileService, "caseDownloadGrant">;
}>;
async function available<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch (error) {
    if (error instanceof TrustCaseError) throw error;
    if (error instanceof Error && ["CommissionError", "CommissionFileError", "CommissionRefundError", "ResolutionError"].includes(error.name)
      && "code" in error && error.code === "not_available") throw new TrustCaseError("not_available");
    throw new TrustCaseError("dependency_unavailable");
  }
}
/** Private composition, supplied only to Trust's open-case, audited evidence path. */
export function createCaseEvidencePort(input: Input): TrustCaseEvidencePort {
  return {
    orderSummary: (tx, orderId) => available(() => input.orders.readOrderForCase(tx, orderId)),
    threadPage: (tx, orderId, beforeSequence) => available(() => input.orders.readThreadForCase(tx, { orderId, ...(beforeSequence === undefined ? {} : { beforeSequence }), limit: 25 })),
    resolutionRecords: (tx, orderId) => available(async () => ({ ...await input.view.readForCase(tx, orderId), refunds: await input.refunds.listForOrder(tx, { orderId }) })),
    refundDestination: (tx, obligationId) => available(() => input.refunds.revealForCase(tx, obligationId)),
    fileGrant: (tx, command) => available(() => input.files.caseDownloadGrant(tx, command)),
  };
}
