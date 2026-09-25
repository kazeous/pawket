import { identityCreatorCapabilities, type PawketTransaction } from "@pawket/database";
import { and, eq } from "drizzle-orm";
import { createIdentityTipAssurancePort } from "./tip-assurance-port.js";

/** Current identity and creator capability are both commit fences for setup. */
export function createIdentitySePayAssurancePort() {
  const sessions = createIdentityTipAssurancePort();
  return {
    async getTipSessionAssurance(tx: PawketTransaction, actor: { userId: string; sessionId: string }, at: Date) {
      const proof = await sessions.getTipSessionAssurance(tx, actor, at);
      if (!proof) return null;
      const [capability] = await tx.select({ id: identityCreatorCapabilities.id }).from(identityCreatorCapabilities)
        .where(and(eq(identityCreatorCapabilities.userId, actor.userId), eq(identityCreatorCapabilities.state, "active"))).limit(1).for("share");
      return capability ? proof : null;
    },
  };
}
