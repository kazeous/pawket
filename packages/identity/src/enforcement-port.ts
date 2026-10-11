import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  creatorPages, identityCreatorCapabilities, identityCreatorCapabilityEvents, identityRoleGrants,
  identitySessions, identityUsers, insertOutboxEvent, type PawketTransaction,
} from "@pawket/database";
import { revokeOidcUserSessions } from "./oidc-session-store.js";

export type EnforcementActor = { userId: string; sessionId: string; stepUpProofId: string };
export type CreatorCapabilityState = "active" | "suspended" | "removed";
export type AccountAccessStatus = "active" | "access_suspended" | "closed";
type CapabilityChange = {
  userId: string; capabilityId: string; previousState: CreatorCapabilityState; state: CreatorCapabilityState; version: number;
  penaltyId: string | null; actor: EnforcementActor | null; reasonCode: string; requestId: string; at: Date;
};

/** Shared with legacy admin commands, which retain their state update, catalog transition and audit. */
export async function recordCreatorCapabilityChange(tx: PawketTransaction, change: CapabilityChange, newId: () => string = randomUUID): Promise<void> {
  const action = change.state === "removed" ? "removed" : change.state === "suspended" ? "suspended"
    : change.previousState === "removed" ? "restored" : "reinstated";
  await tx.insert(identityCreatorCapabilityEvents).values({ id: newId(), capabilityId: change.capabilityId, action,
    state: change.state, version: change.version, penaltyId: change.penaltyId,
    actorUserId: change.actor?.userId ?? null, actorSessionId: change.actor?.sessionId ?? null,
    stepUpProofId: change.actor?.stepUpProofId ?? null, reasonCode: change.reasonCode, requestId: change.requestId, createdAt: change.at });
  await tx.update(identityUsers).set({ authorizationVersion: sql`${identityUsers.authorizationVersion} + 1`, updatedAt: change.at })
    .where(eq(identityUsers.id, change.userId));
  // Preserve the existing creator-capability revocation behaviour for the legacy admin path.
  await tx.update(identitySessions).set({ revokedAt: change.at, revocationReason: "creator_capability_changed", updatedAt: change.at })
    .where(and(eq(identitySessions.userId, change.userId), isNull(identitySessions.revokedAt)));
  await insertOutboxEvent(tx, { eventType: `creator.capability_${action}.v1`, eventVersion: 1,
    aggregateType: "creator_capability", aggregateId: change.capabilityId,
    payload: { userId: change.userId, capabilityId: change.capabilityId, state: change.state, correlationId: change.requestId }, occurredAt: change.at });
}

export function createIdentityEnforcementPort(input: {
  clearPublishedHeadForSuspension(tx: PawketTransaction, input: {
    creatorUserId: string; actorUserId: string | null; actorSessionId: string | null; reasonCode: string; requestId: string; occurredAt: Date;
  }): Promise<{ pageId: string | null; previousPublishedRevisionId: string | null }>;
  newId?(): string;
}) {
  const newId = input.newId ?? randomUUID;
  return {
    /** Caller holds lockCommissionCreator(userId). Keep capability -> page -> user lock order. */
    async lockSubject(tx: PawketTransaction, userId: string): Promise<{
      userId: string; accessStatus: AccountAccessStatus; isOwner: boolean;
      capability: { id: string; state: CreatorCapabilityState; version: number } | null;
    } | null> {
      const [capability] = await tx.select({ id: identityCreatorCapabilities.id, state: identityCreatorCapabilities.state, version: identityCreatorCapabilities.version })
        .from(identityCreatorCapabilities).where(eq(identityCreatorCapabilities.userId, userId)).limit(1).for("update");
      // The later publication clear must never acquire the page lock after the user lock.
      await tx.select({ id: creatorPages.id }).from(creatorPages).where(eq(creatorPages.userId, userId)).limit(1).for("update");
      const [user] = await tx.select({ userId: identityUsers.id, accessStatus: identityUsers.accessStatus }).from(identityUsers)
        .where(eq(identityUsers.id, userId)).limit(1).for("update");
      if (!user) return null;
      const [owner] = await tx.select({ id: identityRoleGrants.id }).from(identityRoleGrants).where(and(
        eq(identityRoleGrants.userId, userId), eq(identityRoleGrants.role, "owner"), eq(identityRoleGrants.state, "active"),
      )).limit(1).for("share");
      return { userId: user.userId, accessStatus: user.accessStatus as AccountAccessStatus, isOwner: Boolean(owner),
        capability: capability ? { ...capability, state: capability.state as CreatorCapabilityState } : null };
    },
    /** Caller has locked the subject with lockSubject in this transaction. */
    async setCreatorCapability(tx: PawketTransaction, command: {
      userId: string; state: CreatorCapabilityState; penaltyId: string; actor: EnforcementActor | null; requestId: string; at: Date;
    }): Promise<{ changed: boolean }> {
      const [capability] = await tx.select().from(identityCreatorCapabilities).where(eq(identityCreatorCapabilities.userId, command.userId)).limit(1);
      if (!capability || capability.state === command.state) return { changed: false };
      const reasonCode = command.actor === null ? "penalty_expired" : command.state === "active" ? "penalty_ended" : "penalty_applied";
      const [updated] = await tx.update(identityCreatorCapabilities).set({ state: command.state, version: capability.version + 1,
        suspendedAt: command.state === "active" ? null : command.at, updatedAt: command.at,
      }).where(and(eq(identityCreatorCapabilities.id, capability.id), eq(identityCreatorCapabilities.version, capability.version))).returning();
      if (!updated) throw new Error("Creator capability version conflict");
      if (capability.state === "active") await input.clearPublishedHeadForSuspension(tx, {
        creatorUserId: command.userId, actorUserId: command.actor?.userId ?? null, actorSessionId: command.actor?.sessionId ?? null,
        reasonCode, requestId: command.requestId, occurredAt: command.at,
      });
      await recordCreatorCapabilityChange(tx, { ...command, capabilityId: capability.id, previousState: capability.state as CreatorCapabilityState,
        version: updated.version, reasonCode }, newId);
      return { changed: true };
    },
    /** Caller already holds the user UPDATE lock; revocation must not re-lock the user. */
    async setAccountAccess(tx: PawketTransaction, command: {
      userId: string; status: AccountAccessStatus; penaltyId: string; actor: EnforcementActor | null; requestId: string; at: Date;
    }): Promise<{ changed: boolean }> {
      const [user] = await tx.select({ accessStatus: identityUsers.accessStatus }).from(identityUsers).where(eq(identityUsers.id, command.userId)).limit(1);
      if (!user || user.accessStatus === command.status) return { changed: false };
      await tx.update(identityUsers).set({ accessStatus: command.status, authorizationVersion: sql`${identityUsers.authorizationVersion} + 1`, updatedAt: command.at })
        .where(eq(identityUsers.id, command.userId));
      await revokeOidcUserSessions(tx, { userId: command.userId, now: command.at, reason: "account_enforcement" });
      await insertOutboxEvent(tx, { eventType: "identity.account_access_changed.v1", eventVersion: 1, aggregateType: "identity_user", aggregateId: command.userId,
        payload: { userId: command.userId, status: command.status }, occurredAt: command.at });
      return { changed: true };
    },
  };
}
export type IdentityEnforcementPort = ReturnType<typeof createIdentityEnforcementPort>;
