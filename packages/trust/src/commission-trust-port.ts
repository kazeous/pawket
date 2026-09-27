import { creatorPages, publicVisibilityHolds, type PawketTransaction } from "@pawket/database";
import { and, eq, isNull } from "drizzle-orm";

/** A moderation hold blocks payment; ordinary unpublishing only stops new intake. */
export function createCommissionTrustPort() {
  return {
    async lockCommissionPage(tx: PawketTransaction, creatorUserId: string): Promise<boolean> {
      // Triage owns page -> owner-assurance locks. Never wait for that page while
      // commission participant assurance might hold the same owner's user row.
      const [page] = await tx.select({ id: creatorPages.id }).from(creatorPages).where(eq(creatorPages.userId, creatorUserId)).limit(1).for("share", { skipLocked: true });
      if (!page) {
        const [exists] = await tx.select({ id: creatorPages.id }).from(creatorPages).where(eq(creatorPages.userId, creatorUserId)).limit(1);
        if (exists) { const error = new Error("Commission moderation fence is busy"); error.name = "CommissionEligibilityBusyError"; throw error; }
        return false;
      }
      const [hold] = await tx.select({ id: publicVisibilityHolds.id }).from(publicVisibilityHolds).where(and(eq(publicVisibilityHolds.targetType, "page"),
        eq(publicVisibilityHolds.targetId, page.id), isNull(publicVisibilityHolds.releasedAt))).limit(1);
      return !hold;
    },
  };
}
