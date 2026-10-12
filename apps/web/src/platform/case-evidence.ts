import type { CommissionFileService } from "@pawket/commission-files";
import type { CommissionPackageService } from "@pawket/catalog";
import { and, asc, eq } from "drizzle-orm";
import { trustAppeals, trustCases, trustContentHides, trustPenalties, trustReports, type PawketTransaction } from "@pawket/database";
import { decryptSensitiveField, type EncryptionKeyring } from "@pawket/security";
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
  keyring?: EncryptionKeyring;
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
// Reused report sections must never carry reporter identity into appeal evidence.
function withoutReporterFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutReporterFields);
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/reporter/iu.test(key))
    .map(([key, item]) => [key, withoutReporterFields(item)]));
}
/** Private composition, supplied only to Trust's open-case, audited evidence path. */
export function createCaseEvidencePort(input: Input): TrustCaseEvidencePort {
  const stageAKinds = ["dispute", "refund_not_received", "refund_overdue", "late_payment"];
  async function appealOrigin(tx: PawketTransaction, caseId: string) {
    const [appeal] = await tx.select({ appeal: trustAppeals }).from(trustAppeals).innerJoin(trustCases, eq(trustCases.id, trustAppeals.caseId))
      .where(and(eq(trustCases.id, caseId), eq(trustCases.kind, "appeal"), eq(trustCases.sourceId, trustAppeals.id))).limit(1);
    if (!appeal) throw new TrustCaseError("not_available");
    const row = appeal.appeal;
    const [penalty] = row.penaltyId === null ? [] : await tx.select().from(trustPenalties).where(eq(trustPenalties.id, row.penaltyId)).limit(1);
    const [hide] = row.hideId === null ? [] : await tx.select().from(trustContentHides).where(eq(trustContentHides.id, row.hideId)).limit(1);
    if (!penalty && !hide) throw new TrustCaseError("not_available");
    const sourceCaseId = penalty?.sourceCaseId ?? hide?.caseId ?? null;
    const [source] = sourceCaseId === null ? [] : await tx.select().from(trustCases).where(eq(trustCases.id, sourceCaseId)).limit(1);
    return { row, penalty, hide, source };
  }
  async function fileInScope(tx: PawketTransaction, caseId: string, fileId: string, visited = new Set<string>()): Promise<boolean> {
    if (visited.has(caseId)) return false;
    visited.add(caseId);
    const [row] = await tx.select().from(trustCases).where(eq(trustCases.id, caseId)).limit(1);
    if (!row || row.orderId === null) return false;
    if (stageAKinds.includes(row.kind)) return true;
    if (row.kind === "appeal") {
      const { source } = await appealOrigin(tx, caseId);
      return source ? fileInScope(tx, source.id, fileId, visited) : false;
    }
    if (row.kind !== "report") return false;
    if (row.sourceType === "commission_brief") {
      const order = await input.orders.readOrderForCase(tx, row.orderId);
      return order.referenceFiles.some((file) => file.fileId === fileId);
    }
    if (row.sourceType !== "commission_file" && row.sourceType !== "commission_message") return false;
    const page = await input.orders.readThreadForCase(tx, { orderId: row.orderId, limit: 50, reportTarget: { kind: row.sourceType, id: row.sourceId } });
    const carrier = row.sourceType === "commission_message" ? page.items.find((item) => item.kind === "message" && item.id === row.sourceId)
      : page.items.find((item) => item.files.some((file) => file.fileId === row.sourceId));
    return carrier?.files.some((file) => file.fileId === fileId) ?? false;
  }
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
  const port: TrustCaseEvidencePort = {
    fileInScope: (tx, caseId, fileId) => available(() => fileInScope(tx, caseId, fileId)),
    appealSource: (tx, caseId) => available(async () => {
      if (!input.keyring) throw new TrustCaseError("not_available");
      const { row, penalty, hide, source } = await appealOrigin(tx, caseId);
      const sections: Record<string, unknown> = {};
      // These readers operate in the appeal's already-authorized transaction; access is logged against the appeal case.
      if (source && stageAKinds.includes(source.kind) && source.orderId !== null) {
        sections.order_summary = await port.orderSummary(tx, source.orderId);
        sections.thread_page = await port.threadPage(tx, source.orderId);
        sections.resolution_records = await port.resolutionRecords(tx, source.orderId);
      }
      if (source?.kind === "report") {
        sections.report_context = withoutReporterFields(await port.reportContext!(tx, source.id));
        if (source.sourceType === "commission_package") sections.package_revision = withoutReporterFields(await port.packageRevision!(tx, source.id));
        if (source.sourceType === "commission_brief") sections.brief = withoutReporterFields(await port.brief!(tx, requireOrder(source.orderId)));
      }
      if (source?.kind === "appeal") sections.appeal_source = await port.appealSource!(tx, source.id);
      return { appeal: { appealId: row.id, statement: decryptSensitiveField({ keyring: input.keyring, envelope: row.statementEnvelope,
        binding: { recordType: "trust_appeals", recordId: row.id, fieldName: "statement" } }) },
        action: penalty ? { penaltyId: penalty.id, kind: penalty.kind, restriction: penalty.restriction, target: penalty.target, state: penalty.state,
          explanation: decryptSensitiveField({ keyring: input.keyring, envelope: penalty.explanationEnvelope, binding: { recordType: "trust_penalties", recordId: penalty.id, fieldName: "explanation" } }) }
          : { hideId: hide!.id, kind: hide!.targetKind, reason: decryptSensitiveField({ keyring: input.keyring, envelope: hide!.reasonEnvelope,
            binding: { recordType: "trust_content_hides", recordId: hide!.id, fieldName: "reason" } }) },
        source: source ? { caseId: source.id, kind: source.kind, state: source.state } : null, sections };
    }),
    reportContext: (tx, caseId) => available(async () => {
      if (!input.keyring) throw new TrustCaseError("not_available");
      const reports = await tx.select({ id: trustReports.id, reason: trustReports.reason, createdAt: trustReports.createdAt, reporterUserId: trustReports.reporterUserId, detailEnvelope: trustReports.detailEnvelope }).from(trustReports).where(eq(trustReports.caseId, caseId)).orderBy(asc(trustReports.createdAt), asc(trustReports.id));
      const items = reports.map((report) => ({ reportId: report.id, reasonCategory: report.reason, createdAt: report.createdAt.toISOString(), reporterUserId: report.reporterUserId,
        detail: report.detailEnvelope === null ? null : decryptSensitiveField({ keyring: input.keyring!, envelope: report.detailEnvelope, binding: { recordType: "trust_reports", recordId: report.id, fieldName: "detail" } }) }));
      const row = await report(tx, caseId);
      if (row.sourceType === "commission_package") return { kind: row.sourceType, reports: items, revision: await packageRevision(tx, caseId) };
      const orderId = requireOrder(row.orderId);
      if (row.sourceType === "commission_brief") return { kind: row.sourceType, reports: items, brief: await brief(tx, orderId) };
      if (row.sourceType !== "commission_message" && row.sourceType !== "commission_file") throw new TrustCaseError("not_available");
      const page = await input.orders.readThreadForCase(tx, { orderId, limit: 50, reportTarget: { kind: row.sourceType, id: row.sourceId } });
      if (row.sourceType === "commission_message") return { kind: row.sourceType, reports: items, messageId: row.sourceId, messages: page.items };
      const carrier = page.items[0]; const file = carrier?.files.find((file) => file.fileId === row.sourceId);
      if (!carrier || !file) throw new TrustCaseError("not_available");
      return { kind: row.sourceType, reports: items, file: { ...file, hidden: file.hidden ?? Boolean(await input.contentHides?.activeHide(tx, "commission_file", row.sourceId)) }, carrier };
    }),
    packageRevision: (tx, caseId) => available(() => packageRevision(tx, caseId)),
    brief: (tx, orderId) => available(() => brief(tx, requireOrder(orderId))),
    orderSummary: (tx, orderId) => available(() => input.orders.readOrderForCase(tx, requireOrder(orderId))),
    threadPage: (tx, orderId, beforeSequence) => available(() => input.orders.readThreadForCase(tx, { orderId: requireOrder(orderId), ...(beforeSequence === undefined ? {} : { beforeSequence }), limit: 25 })),
    resolutionRecords: (tx, orderId) => available(async () => ({ ...await input.view.readForCase(tx, requireOrder(orderId)), refunds: await input.refunds.listForOrder(tx, { orderId: requireOrder(orderId) }) })),
    refundDestination: (tx, obligationId) => available(() => input.refunds.revealForCase(tx, obligationId)),
    fileGrant: (tx, command) => available(() => input.files.caseDownloadGrant(tx, { ...command, orderId: requireOrder(command.orderId) })),
  };
  return port;
}
