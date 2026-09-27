import { identityCreatorCapabilities, identityUsers, type PawketTransaction } from "@pawket/database";
import { asc, eq, inArray } from "drizzle-orm";
import { createIdentityTipAssurancePort } from "./tip-assurance-port.js";

/** Called after the commission creator fence and before account/order locks. */
export function createIdentityCommissionAssurancePort() {
  const sessions = createIdentityTipAssurancePort();
  async function capability(tx: PawketTransaction, userId: string) {
    // Capability suspension takes capability -> page -> user. A session reader may
    // already hold the user share lock, so it must never wait for that capability.
    const [locked] = await tx.select({ id: identityCreatorCapabilities.id, state: identityCreatorCapabilities.state }).from(identityCreatorCapabilities)
      .where(eq(identityCreatorCapabilities.userId, userId)).limit(1).for("share", { skipLocked: true });
    if (locked) return locked.state === "active";
    const [exists] = await tx.select({ id: identityCreatorCapabilities.id }).from(identityCreatorCapabilities).where(eq(identityCreatorCapabilities.userId, userId)).limit(1);
    if (exists) { const error = new Error("Commission identity fence is busy"); error.name = "CommissionEligibilityBusyError"; throw error; }
    return false;
  }
  return {
    getTipSessionAssurance: sessions.getTipSessionAssurance,
    async lockSettlementParticipants(tx: PawketTransaction, command: { creatorUserId: string; buyerUserId: string; at: Date }): Promise<boolean> {
      if (command.creatorUserId === command.buyerUserId || !Number.isFinite(command.at.getTime())) return false;
      if (!await capability(tx, command.creatorUserId)) return false;
      // Stable order also applies when a creator commissions another creator.
      const users = await tx.select({ id: identityUsers.id, active: identityUsers.accessStatus, verified: identityUsers.emailVerified, createdAt: identityUsers.createdAt })
        .from(identityUsers).where(inArray(identityUsers.id, [command.creatorUserId, command.buyerUserId])).orderBy(asc(identityUsers.id)).for("share");
      if (users.length !== 2 || users.some((user) => user.active !== "active" || !user.verified || user.createdAt > command.at)) return false;
      return true;
    },
    async lockCreator(tx: PawketTransaction, actor: { userId: string; sessionId: string }, at: Date) {
      const proof = await sessions.getTipSessionAssurance(tx, actor, at);
      if (!proof) return null;
      return await capability(tx, actor.userId) ? proof : null;
    },
  };
}
