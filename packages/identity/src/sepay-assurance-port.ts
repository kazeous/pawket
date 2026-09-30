import { identityCreatorCapabilities, type PawketTransaction } from "@pawket/database";
import { and, eq } from "drizzle-orm";
import { createIdentityTipAssurancePort } from "./tip-assurance-port.js";
import type { OidcSessionProvider } from "./oidc-session.js";

/** Current identity and creator capability are both commit fences for setup. */
export function createIdentitySePayAssurancePort(provider: OidcSessionProvider, clock: () => Date = () => new Date()) {
  const sessions = createIdentityTipAssurancePort(provider, clock);
  return {
    async getTipSessionAssurance(tx: PawketTransaction, actor: { userId: string; sessionId: string }, at: Date) {
      const proof = await sessions.getTipSessionAssurance(tx, actor, at);
      if (!proof) return null;
      const [capability] = await tx.select({ id: identityCreatorCapabilities.id }).from(identityCreatorCapabilities)
        .where(and(eq(identityCreatorCapabilities.userId, actor.userId), eq(identityCreatorCapabilities.state, "active"))).limit(1).for("share");
      return capability && proof.sessionExpiresAt > clock() ? proof : null;
    },
  };
}
