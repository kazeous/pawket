import { and, eq, isNull } from "drizzle-orm";
import { commissionOrders, commissionPackages, creatorPages, creatorPublicationRevisions, identityRoleGrants, publicContentReports, trustAppeals, trustCases, trustContentHides, trustPenalties, trustReports, type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { TrustCaseError } from "@pawket/trust";

/** Owner-only, non-evidence metadata. Private statements remain on the audited evidence path. */
export function createTrustOwnerMetadata(db: PawketDatabase) {
  async function parties(tx: PawketTransaction, candidates: { userId: string; label: string }[]) {
    const unique = [...new Map(candidates.map((party) => [party.userId, party])).values()];
    const result = [];
    for (const party of unique) {
      const [owner] = await tx.select({ id: identityRoleGrants.id }).from(identityRoleGrants).where(and(eq(identityRoleGrants.userId, party.userId), eq(identityRoleGrants.role, "owner"), eq(identityRoleGrants.state, "active"))).limit(1);
      if (!owner) result.push(party);
    }
    return result;
  }
  return {
    readForCase: (caseId: string) => db.transaction(async (tx) => {
      const [row] = await tx.select().from(trustCases).where(eq(trustCases.id, caseId)).limit(1);
      if (!row) throw new TrustCaseError("not_available");
      const candidates: { userId: string; label: string }[] = [];
      if (row.orderId) {
        const [order] = await tx.select({ buyer: commissionOrders.buyerUserId, creator: commissionOrders.creatorUserId }).from(commissionOrders).where(eq(commissionOrders.id, row.orderId)).limit(1);
        if (order) candidates.push({ userId: order.creator, label: "Nghệ sĩ" }, { userId: order.buyer, label: "Người mua" });
      }
      const reports = await tx.select({ userId: trustReports.contentOwnerUserId }).from(trustReports).where(eq(trustReports.caseId, caseId));
      candidates.push(...reports.map(({ userId }) => ({ userId, label: "Chủ nội dung" })));
      if (row.kind === "report" && row.sourceType === "commission_package") {
        const [pkg] = await tx.select({ userId: commissionPackages.creatorUserId }).from(commissionPackages).where(eq(commissionPackages.id, row.sourceId)).limit(1);
        if (pkg) candidates.push({ ...pkg, label: "Nghệ sĩ" });
      }
      const [hide] = row.kind !== "report" ? [] : await tx.select({ hideId: trustContentHides.id }).from(trustContentHides)
        .where(and(eq(trustContentHides.caseId, caseId), eq(trustContentHides.targetKind, row.sourceType as "commission_message" | "commission_file" | "commission_package"), eq(trustContentHides.targetId, row.sourceId), isNull(trustContentHides.releasedAt))).limit(1);
      const [appeal] = row.kind !== "appeal" ? [] : await tx.select({ penaltyId: trustAppeals.penaltyId, hideId: trustAppeals.hideId }).from(trustAppeals).where(eq(trustAppeals.caseId, caseId)).limit(1);
      const [penalty] = !appeal?.penaltyId ? [] : await tx.select({ penaltyId: trustPenalties.id, kind: trustPenalties.kind, restriction: trustPenalties.restriction, target: trustPenalties.target, endsAt: trustPenalties.endsAt }).from(trustPenalties).where(eq(trustPenalties.id, appeal.penaltyId)).limit(1);
      const [originalHide] = !appeal?.hideId ? [] : await tx.select({ hideId: trustContentHides.id, kind: trustContentHides.targetKind }).from(trustContentHides).where(eq(trustContentHides.id, appeal.hideId)).limit(1);
      return { parties: await parties(tx, candidates), activeHideId: hide?.hideId ?? null,
        appealAction: penalty ? { ...penalty, endsAt: penalty.endsAt?.toISOString() ?? null } : originalHide ?? null };
    }),
    publicReportParties: (reportId: string) => db.transaction(async (tx) => {
      const [creator] = await tx.select({ userId: creatorPages.userId }).from(publicContentReports)
        .innerJoin(creatorPublicationRevisions, eq(creatorPublicationRevisions.id, publicContentReports.publicationRevisionId))
        .innerJoin(creatorPages, eq(creatorPages.id, creatorPublicationRevisions.pageId)).where(eq(publicContentReports.id, reportId)).limit(1);
      if (!creator) throw new TrustCaseError("not_available");
      return { parties: await parties(tx, [{ ...creator, label: "Nghệ sĩ" }]) };
    }),
  };
}
