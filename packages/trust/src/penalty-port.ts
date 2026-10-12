import { and, asc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { identityUsers, trustPenalties, type PawketTransaction } from "@pawket/database";
import { trustFail, type TrustEnforcementMode, type TrustRestriction } from "./enforcement-policy.js";

/** Call after the subject user SHARE lock when this read is part of a command. */
export async function activePenalties(tx: PawketTransaction, userId: string, at: Date) {
  return tx.select().from(trustPenalties).where(and(
    eq(trustPenalties.subjectUserId, userId), eq(trustPenalties.state, "active"), lte(trustPenalties.startsAt, at),
    or(isNull(trustPenalties.endsAt), gt(trustPenalties.endsAt, at)),
  )).orderBy(asc(trustPenalties.startsAt), asc(trustPenalties.id));
}

export function createTrustRestrictionPort(input: { mode: TrustEnforcementMode }) {
  async function isRestricted(tx: PawketTransaction, command: { userId: string; restriction: TrustRestriction; at: Date }): Promise<boolean> {
    if (input.mode === "disabled") return false;
    const [restriction] = await tx.select({ id: trustPenalties.id }).from(trustPenalties).where(and(
      eq(trustPenalties.subjectUserId, command.userId), eq(trustPenalties.kind, "restriction"),
      eq(trustPenalties.restriction, command.restriction), eq(trustPenalties.state, "active"),
      lte(trustPenalties.startsAt, command.at), or(isNull(trustPenalties.endsAt), gt(trustPenalties.endsAt, command.at)),
    )).limit(1);
    return Boolean(restriction);
  }
  return {
    // Read-only projections use the existing creator fence without acquiring a user row lock.
    isRestricted,
    async assertAllowed(tx: PawketTransaction, command: { userId: string; restriction: TrustRestriction; at: Date }): Promise<void> {
      if (input.mode === "disabled") return;
      await tx.select({ id: identityUsers.id }).from(identityUsers).where(eq(identityUsers.id, command.userId)).for("share");
      if (await isRestricted(tx, command)) trustFail("restricted");
    },
  };
}
export type TrustRestrictionPort = ReturnType<typeof createTrustRestrictionPort>;
