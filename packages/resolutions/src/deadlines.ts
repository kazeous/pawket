import { asc } from "drizzle-orm";
import { commissionResolutionPauses, type PawketTransaction } from "@pawket/database";
import { commissionCompletionDueAt } from "@pawket/orders";
import { RESOLUTION_POLICY } from "./policy.js";

export async function effectiveResolutionDeadline(tx: PawketTransaction, deadline: Date): Promise<Date | null> {
  const pauses = await tx.select({ startedAt: commissionResolutionPauses.startedAt, endedAt: commissionResolutionPauses.endedAt })
    .from(commissionResolutionPauses).orderBy(asc(commissionResolutionPauses.startedAt));
  return commissionCompletionDueAt(deadline, pauses, RESOLUTION_POLICY.pauseGraceMs);
}
