import { and, eq } from "drizzle-orm";
import { trustAppeals, trustPenalties, type PawketDatabase } from "@pawket/database";
import { decryptSensitiveField, type EncryptionKeyring } from "@pawket/security";
import { TrustEnforcementError, trustFail, type TrustEnforcementMode } from "./enforcement-policy.js";
import type { HelpLinkService } from "./help-link-service.js";

export type HelpCaseView = Readonly<{
  penaltyId: string; kind: "suspension" | "removal"; state: typeof trustPenalties.$inferSelect.state;
  explanation: string; startsAt: string; endsAt: string | null; enforcementPolicyRevisionId: string | null;
  canAppeal: boolean; readOnlyUntil: string;
  appeal: { state: typeof trustAppeals.$inferSelect.state; reasoning: string | null; decidedAt: string | null } | null;
}>;

/** A help session grants access to one penalty, never the subject's other cases or reports. */
export function createHelpCaseService(input: { db: PawketDatabase; keyring: EncryptionKeyring; mode: TrustEnforcementMode;
  helpLinks: Pick<HelpLinkService, "readSession"> }) {
  return { async read(sessionToken: string): Promise<HelpCaseView | null> {
    if (input.mode !== "enabled") return null;
    try {
      return await input.db.transaction(async (tx) => {
        const session = await input.helpLinks.readSession(sessionToken, tx); if (!session) return null;
        const [penalty] = await tx.select({ penaltyId: trustPenalties.id, kind: trustPenalties.kind, state: trustPenalties.state,
          explanationEnvelope: trustPenalties.explanationEnvelope, startsAt: trustPenalties.startsAt, endsAt: trustPenalties.endsAt,
          enforcementPolicyRevisionId: trustPenalties.enforcementPolicyRevisionId }).from(trustPenalties)
          .where(and(eq(trustPenalties.id, session.penaltyId), eq(trustPenalties.subjectUserId, session.userId), eq(trustPenalties.target, "account"))).limit(1);
        if (!penalty || penalty.kind !== "suspension" && penalty.kind !== "removal") return null;
        const [appeal] = await tx.select({ id: trustAppeals.id, state: trustAppeals.state, reasoningEnvelope: trustAppeals.reasoningEnvelope,
          decidedAt: trustAppeals.decidedAt }).from(trustAppeals)
          .where(and(eq(trustAppeals.penaltyId, penalty.penaltyId), eq(trustAppeals.appellantUserId, session.userId))).limit(1);
        const decrypt = (recordType: string, recordId: string, fieldName: string, envelope: Parameters<typeof decryptSensitiveField>[0]["envelope"]) =>
          decryptSensitiveField({ keyring: input.keyring, envelope, binding: { recordType, recordId, fieldName } });
        // Explicit allowlist: source IDs, reporter data, owner data and appeal statements never leave this service.
        return { penaltyId: penalty.penaltyId, kind: penalty.kind, state: penalty.state,
          explanation: decrypt("trust_penalties", penalty.penaltyId, "explanation", penalty.explanationEnvelope),
          startsAt: penalty.startsAt.toISOString(), endsAt: penalty.endsAt?.toISOString() ?? null,
          enforcementPolicyRevisionId: penalty.enforcementPolicyRevisionId, canAppeal: session.canAppeal && !appeal,
          readOnlyUntil: session.readOnlyUntil.toISOString(), appeal: appeal ? { state: appeal.state,
            reasoning: appeal.state !== "open" && appeal.reasoningEnvelope ? decrypt("trust_appeals", appeal.id, "reasoning", appeal.reasoningEnvelope) : null,
            decidedAt: appeal.decidedAt?.toISOString() ?? null } : null };
      });
    } catch (error) { if (error instanceof TrustEnforcementError) throw error; return trustFail("dependency_unavailable"); }
  } };
}
