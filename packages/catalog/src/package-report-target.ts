import { and, eq, inArray } from "drizzle-orm";
import { commissionPackages, commissionPackageRevisions, creatorPages, identityCreatorCapabilities, type PawketTransaction } from "@pawket/database";
import { commissionUuid, lockCommissionCreator } from "@pawket/orders";
import type { createPublicCatalogQuery } from "./public-catalog-query.js";

/** Structural trust port: Catalog owns public package visibility and does not import Trust. */
export function createPackageReportTargetPort(input: { intakeMode: "disabled" | "enabled"; publishingMode: "disabled" | "general_audience";
  visibility: Pick<ReturnType<typeof createPublicCatalogQuery>, "resolveVisibleReportTarget"> }) {
  return {
    async resolve(tx: PawketTransaction, target: { kind: string; packageId?: string; revisionId?: string }, reporter: { userId: string } | null) {
      if (target.kind !== "commission_package" || !commissionUuid(target.packageId) || !commissionUuid(target.revisionId)
        || input.intakeMode !== "enabled" || input.publishingMode !== "general_audience") return null;
      const [candidate] = await tx.select({ creatorUserId: commissionPackages.creatorUserId }).from(commissionPackages).where(eq(commissionPackages.id, target.packageId)).limit(1);
      if (!candidate || candidate.creatorUserId === reporter?.userId) return null;
      await lockCommissionCreator(tx, candidate.creatorUserId);
      // Same lock order as enforcement and commission publishing: fence, capability, then page.
      await tx.select({ id: identityCreatorCapabilities.id }).from(identityCreatorCapabilities).where(eq(identityCreatorCapabilities.userId, candidate.creatorUserId)).for("update");
      const [row] = await tx.select({ pageId: commissionPackages.pageId, creatorUserId: commissionPackages.creatorUserId }).from(commissionPackages)
        .innerJoin(commissionPackageRevisions, and(eq(commissionPackageRevisions.id, commissionPackages.publishedRevisionId), eq(commissionPackageRevisions.packageId, commissionPackages.id)))
        .where(and(eq(commissionPackages.id, target.packageId), eq(commissionPackages.publishedRevisionId, target.revisionId),
          inArray(commissionPackages.state, ["open", "paused"]))).limit(1);
      if (!row || row.creatorUserId !== candidate.creatorUserId) return null;
      const [page] = await tx.select({ id: creatorPages.id, publishedRevisionId: creatorPages.publishedRevisionId }).from(creatorPages)
        .where(and(eq(creatorPages.id, row.pageId), eq(creatorPages.userId, row.creatorUserId))).limit(1).for("update");
      if (!page?.publishedRevisionId) return null;
      const visible = await input.visibility.resolveVisibleReportTarget(tx, { targetType: "page", targetId: page.id, publicationRevisionId: page.publishedRevisionId });
      if (!visible || visible.creatorUserId !== row.creatorUserId || visible.pageId !== page.id || visible.target.publicationRevisionId !== page.publishedRevisionId) return null;
      return { kind: "commission_package" as const, targetId: target.packageId, orderId: null, contentOwnerUserId: row.creatorUserId, packageRevisionId: target.revisionId };
    },
  };
}
