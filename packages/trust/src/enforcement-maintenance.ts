import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";
import { trustHelpLinks, trustHelpLinkRequests, trustHelpSessions, trustPenalties, type PawketDatabase } from "@pawket/database";
import { recordEnforcementModeTransition } from "./enforcement-deadlines.js";
import { trustFail, type TrustEnforcementMode } from "./enforcement-policy.js";
import type { PenaltyService } from "./penalty-service.js";

export function createEnforcementMaintenance(input: {
  db: PawketDatabase; penalties: Pick<PenaltyService, "end">; now?(): Date; batch?: number;
  mode?: TrustEnforcementMode; onPenaltyFailure?(penaltyId: string): void;
}) {
  const batch = input.batch ?? 100; const mode = input.mode ?? "disabled";
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > 500 || !["disabled", "enabled"].includes(mode)
    || typeof input.penalties?.end !== "function") trustFail("invalid_request");
  const clock = input.now ?? (() => new Date());
  return {
    async runOnce(): Promise<{ expired: number; purgedSessions: number; purgedRequests: number }> {
      const value = clock();
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) trustFail("invalid_request");
      const at = new Date(value);
      await recordEnforcementModeTransition(input.db, { mode, at });
      // Read routing IDs without row locks. end takes fence -> capability -> page -> user -> penalty,
      // rechecks eligibility under FOR UPDATE SKIP LOCKED, and recomputes standing in the same transaction.
      const candidates = await input.db.select({ id: trustPenalties.id }).from(trustPenalties)
        .where(and(eq(trustPenalties.state, "active"), lte(trustPenalties.endsAt, at)))
        .orderBy(asc(trustPenalties.endsAt), asc(trustPenalties.id)).limit(batch);
      let expired = 0;
      for (const candidate of candidates) {
        try {
          if (await input.db.transaction((tx) => input.penalties.end(tx, { penaltyId: candidate.id, state: "expired", actor: null,
            requestId: randomUUID(), at, reason: null }, { skipLocked: true }))) expired += 1;
        } catch {
          // Error contents may contain private data. Only the penalty ID crosses this boundary.
          if (input.onPenaltyFailure) input.onPenaltyFailure(candidate.id);
          else console.error(JSON.stringify({ category: "trust_enforcement_penalty_failed", penaltyId: candidate.id }));
        }
      }
      const sessions = await input.db.delete(trustHelpSessions).where(inArray(trustHelpSessions.id,
        input.db.select({ id: trustHelpSessions.id }).from(trustHelpSessions).where(lte(trustHelpSessions.expiresAt, at))
          .orderBy(asc(trustHelpSessions.expiresAt), asc(trustHelpSessions.id)).limit(batch))).returning({ id: trustHelpSessions.id });
      const requests = await input.db.delete(trustHelpLinkRequests).where(inArray(trustHelpLinkRequests.id,
        input.db.select({ id: trustHelpLinkRequests.id }).from(trustHelpLinkRequests).where(lte(trustHelpLinkRequests.expiresAt, at))
          .orderBy(asc(trustHelpLinkRequests.expiresAt), asc(trustHelpLinkRequests.id)).limit(batch))).returning({ id: trustHelpLinkRequests.id });
      await input.db.update(trustHelpLinks).set({ revokedAt: at }).where(inArray(trustHelpLinks.id,
        input.db.select({ id: trustHelpLinks.id }).from(trustHelpLinks).where(and(isNull(trustHelpLinks.revokedAt), lte(trustHelpLinks.readUntil, at)))
          .orderBy(asc(trustHelpLinks.readUntil), asc(trustHelpLinks.id)).limit(batch)));
      return { expired, purgedSessions: sessions.length, purgedRequests: requests.length };
    },
  };
}
