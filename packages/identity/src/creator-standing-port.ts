import { identityCreatorCapabilities, identityUsers, type PawketTransaction } from "@pawket/database";
import { eq } from "drizzle-orm";

/** Called under the commission creator fence; never waits for a capability held by suspension. */
export function createCreatorStandingPort() {
  return {
    async readCreatorStanding(tx: PawketTransaction, userId: string): Promise<"active" | "suspended" | "none"> {
      // Suspension locks capability -> page -> user. Session readers may already hold the user share lock.
      const [locked] = await tx.select({ id: identityCreatorCapabilities.id, state: identityCreatorCapabilities.state }).from(identityCreatorCapabilities)
        .where(eq(identityCreatorCapabilities.userId, userId)).limit(1).for("share", { skipLocked: true });
      if (!locked) {
        const [exists] = await tx.select({ id: identityCreatorCapabilities.id }).from(identityCreatorCapabilities)
          .where(eq(identityCreatorCapabilities.userId, userId)).limit(1);
        if (exists) { const error = new Error("Commission identity fence is busy"); error.name = "CommissionEligibilityBusyError"; throw error; }
      }
      const [user] = await tx.select({ accessStatus: identityUsers.accessStatus }).from(identityUsers)
        .where(eq(identityUsers.id, userId)).limit(1).for("share");
      if (locked?.state === "suspended" || user?.accessStatus === "access_suspended") return "suspended";
      return locked?.state === "active" && user?.accessStatus === "active" ? "active" : "none";
    },
  };
}
