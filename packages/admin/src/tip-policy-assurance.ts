import { eq } from "drizzle-orm";
import { identitySessions, type PawketTransaction } from "@pawket/database";
import { createStepUpProof, consumeStepUpProof } from "@pawket/identity";
import { resolveOwnerSessionPermission } from "./owner-permission.js";

type Actor = { userId: string; sessionId: string; now: Date };
export function createOwnerTipPolicyAssurancePort() {
  return {
    authorizeOwner(tx: PawketTransaction, actor: Actor) {
      return resolveOwnerSessionPermission(tx, { ...actor, lock: true });
    },
    async requireOwnerStepUp(tx: PawketTransaction, actor: Actor): Promise<boolean> {
      const [session] = await tx.select({ primaryAt: identitySessions.primaryAuthenticatedAt, mfaAt: identitySessions.mfaVerifiedAt })
        .from(identitySessions).where(eq(identitySessions.id, actor.sessionId)).limit(1);
      // Do not accept future-dated assurance as recent authentication.
      if (!session?.primaryAt || !session.mfaAt || session.primaryAt > actor.now || session.mfaAt > actor.now) return false;
      try {
        const actionClass = "owner.tip_policy_update";
        const proof = await createStepUpProof(tx, { ...actor, actionClass, assuranceMethod: "totp" });
        return consumeStepUpProof(tx, { ...actor, proofId: proof.id, actionClass });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "OWNER_TOTP_REQUIRED") return false;
        throw error;
      }
    },
  };
}
