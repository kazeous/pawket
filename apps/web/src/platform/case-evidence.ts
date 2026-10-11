import type { CommissionFileService } from "@pawket/commission-files";
import type { CommissionPackageService } from "@pawket/catalog";
import { and, asc, eq } from "drizzle-orm";
import { trustCases, trustReports, type PawketTransaction } from "@pawket/database";
import type { CommissionOrderService } from "@pawket/orders";
import type { CommissionRefundPort } from "@pawket/payments";
import type { createResolutionViewService } from "@pawket/resolutions";
import { TrustCaseError, type ContentHideReadPort, type TrustCaseEvidencePort } from "@pawket/trust";

type Input = Readonly<{
  orders: Pick<CommissionOrderService, "readOrderForCase" | "readThreadForCase">;
  refunds: Pick<CommissionRefundPort, "listForOrder" | "revealForCase">;
  view: Pick<ReturnType<typeof createResolutionViewService>, "readForCase">;
  files: Pick<CommissionFileService, "caseDownloadGrant">;
  catalog?: Pick<CommissionPackageService, "readRevisionForCase">;
  contentHides?: ContentHideReadPort;
}>;
async function available<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch (error) {
    if (error instanceof TrustCaseError) throw error;
    if (error instanceof Error && ["CommissionError", "CommissionFileError", "CommissionRefundError", "ResolutionError"].includes(error.name)
      && "code" in error && error.code === "not_available") throw new TrustCaseError("not_available");
    throw new TrustCaseError("dependency_unavailable");
  }
}
function requireOrder(orderId: string | null): string {
  if (orderId === null) throw new TrustCaseError("not_available");
  return orderId;
}
/** Private composition, supplied only to Trust's open-case, audited evidence path. */
export function createCaseEvidencePort(input: Input): TrustCaseEvidencePort {
  async function report(tx: PawketTransaction, caseId: string) {
    const [row] = await tx.select({ sourceType: trustCases.sourceType, sourceId: trustCases.sourceId, orderId: trustCases.orderId,
      packageRevisionId: trustReports.packageRevisionId }).from(trustCases).innerJoin(trustReports, eq(trustReports.caseId, trustCases.id))
      .where(and(eq(trustCases.id, caseId), eq(trustCases.kind, "report"))).orderBy(asc(trustReports.createdAt), asc(trustReports.id)).limit(1);
    if (!row) throw new TrustCaseError("not_available"); return row;
  }
  async function brief(tx: PawketTransaction, orderId: string) {
    const order = await input.orders.readOrderForCase(tx, orderId);
    return { ...order.brief, referenceFiles: order.referenceFiles, hidden: false };
  }
  async function packageRevision(tx: PawketTransaction, caseId: string) {
    const row = await report(tx, caseId);
    if (row.sourceType !== "commission_package" || !row.packageRevisionId || !input.catalog) throw new TrustCaseError("not_available");
    return input.catalog.readRevisionForCase(tx, row.packageRevisionId);
  }
  return {
    reportContext: (tx, caseId) => available(async () => {
      const row = await report(tx, caseId);
      if (row.sourceType === "commission_package") return { kind: row.sourceType, revision: await packageRevision(tx, caseId) };
      const orderId = requireOrder(row.orderId);
      if (row.sourceType === "commission_brief") return { kind: row.sourceType, brief: await brief(tx, orderId) };
      if (row.sourceType !== "commission_message" && row.sourceType !== "commission_file") throw new TrustCaseError("not_available");
      const page = await input.orders.readThreadForCase(tx, { orderId, limit: 50, reportTarget: { kind: row.sourceType, id: row.sourceId } });
      if (row.sourceType === "commission_message") return { kind: row.sourceType, messageId: row.sourceId, messages: page.items };
      const carrier = page.items[0]; const file = carrier?.files.find((file) => file.fileId === row.sourceId);
      if (!carrier || !file) throw new TrustCaseError("not_available");
      return { kind: row.sourceType, file: { ...file, hidden: file.hidden ?? Boolean(await input.contentHides?.activeHide(tx, "commission_file", row.sourceId)) }, carrier };
    }),
    packageRevision: (tx, caseId) => available(() => packageRevision(tx, caseId)),
    brief: (tx, orderId) => available(() => brief(tx, requireOrder(orderId))),
    orderSummary: (tx, orderId) => available(() => input.orders.readOrderForCase(tx, requireOrder(orderId))),
    threadPage: (tx, orderId, beforeSequence) => available(() => input.orders.readThreadForCase(tx, { orderId: requireOrder(orderId), ...(beforeSequence === undefined ? {} : { beforeSequence }), limit: 25 })),
    resolutionRecords: (tx, orderId) => available(async () => ({ ...await input.view.readForCase(tx, requireOrder(orderId)), refunds: await input.refunds.listForOrder(tx, { orderId: requireOrder(orderId) }) })),
    refundDestination: (tx, obligationId) => available(() => input.refunds.revealForCase(tx, obligationId)),
    fileGrant: (tx, command) => available(() => input.files.caseDownloadGrant(tx, { ...command, orderId: requireOrder(command.orderId) })),
  };
}
