import { randomBytes, randomUUID } from "node:crypto";

import { and, eq, exists, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";

import {
  identityExternalLinkTransactions,
  identityRecoveryCodes,
  identityRoleGrants,
  identitySessions,
  identityStepUpProofs,
  identityTotpAuthenticators,
  identityUsers,
  type PawketDatabase,
  type PawketTransaction,
} from "@pawket/database";
import { hashOpaqueToken } from "@pawket/security";

import { isAllowedReturnPath } from "./core-identity-policy.js";

type ExternalProvider = "google" | "discord";
type StepUpMethod = "primary" | "totp" | "recovery";
const EXTERNAL_LINK_PROCESSING_LEASE_MS = 10 * 60_000;

function assertValidInstant(value: Date): void {
  if (Number.isNaN(value.getTime())) throw new Error("Invalid identity security operation");
}

function generateRecoveryCode(): string {
  const value = randomBytes(16).toString("base64url").toUpperCase();
  return `${value.slice(0, 11)}-${value.slice(11, 22)}`;
}

function recoveryCodeHash(code: string): string {
  return hashOpaqueToken(code.trim().toUpperCase(), "recovery_code");
}

export async function beginExternalLinkTransaction(
  db: PawketDatabase,
  input: {
    userId: string;
    sessionId: string;
    provider: ExternalProvider;
    returnPath: string;
    now: Date;
    lifetimeMs?: number;
    state?: string;
  },
): Promise<{ id: string; state: string; expiresAt: Date }> {
  assertValidInstant(input.now);
  if (!isAllowedReturnPath(input.returnPath)) {
    throw new Error("Invalid external identity return path");
  }
  const lifetimeMs = input.lifetimeMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 60_000 || lifetimeMs > 15 * 60_000) {
    throw new Error("Invalid external identity transaction lifetime");
  }

  const state = input.state ?? randomBytes(32).toString("base64url");
  if (state.length < 16 || state.length > 2_048) {
    throw new Error("Invalid external identity state");
  }
  const expiresAt = new Date(input.now.getTime() + lifetimeMs);
  return db.transaction(async (tx) => {
    const lockSubject = `identity_external_link:${input.userId}:${input.provider}`;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${lockSubject}, 0))`,
    );
    const [active] = await tx
      .select({ id: identityExternalLinkTransactions.id })
      .from(identityExternalLinkTransactions)
      .where(
        and(
          eq(identityExternalLinkTransactions.userId, input.userId),
          eq(identityExternalLinkTransactions.provider, input.provider),
          inArray(identityExternalLinkTransactions.status, ["pending", "processing"]),
          gt(identityExternalLinkTransactions.expiresAt, input.now),
        ),
      )
      .limit(1);
    if (active) throw new Error("External identity transaction already active");
    const [created] = await tx
      .insert(identityExternalLinkTransactions)
      .values({
        userId: input.userId,
        sessionId: input.sessionId,
        provider: input.provider,
        stateHash: hashOpaqueToken(state, "external_link_state"),
        returnPath: input.returnPath,
        expiresAt,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning({ id: identityExternalLinkTransactions.id });
    if (!created) throw new Error("Failed to begin external identity transaction");
    return { id: created.id, state, expiresAt };
  });
}

export async function finishExternalLinkTransaction(
  db: PawketDatabase,
  input: {
    state: string;
    userId: string;
    sessionId: string;
    provider: ExternalProvider;
    outcome: "completed" | "conflict";
    resultCode: string;
    now: Date;
  },
): Promise<{ id: string; status: string; resultCode: string | null; returnPath: string } | null> {
  assertValidInstant(input.now);
  if (!/^[a-z][a-z0-9_]{1,63}$/u.test(input.resultCode)) {
    throw new Error("Invalid external identity result");
  }
  const [completed] = await db
    .update(identityExternalLinkTransactions)
    .set({
      status: input.outcome,
      resultCode: input.resultCode,
      consumedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(
          identityExternalLinkTransactions.stateHash,
          hashOpaqueToken(input.state, "external_link_state"),
        ),
        eq(identityExternalLinkTransactions.userId, input.userId),
        eq(identityExternalLinkTransactions.sessionId, input.sessionId),
        eq(identityExternalLinkTransactions.provider, input.provider),
        eq(identityExternalLinkTransactions.status, "pending"),
        gt(identityExternalLinkTransactions.expiresAt, input.now),
      ),
    )
    .returning({
      id: identityExternalLinkTransactions.id,
      status: identityExternalLinkTransactions.status,
      resultCode: identityExternalLinkTransactions.resultCode,
      returnPath: identityExternalLinkTransactions.returnPath,
    });
  return completed ?? null;
}

export async function claimExternalLinkTransaction(
  db: PawketDatabase,
  input: {
    state: string;
    userId: string | null;
    sessionId: string | null;
    provider: ExternalProvider;
    now: Date;
  },
): Promise<
  | { kind: "not_found" }
  | { kind: "invalid" }
  | { kind: "claimed"; id: string; userId: string; sessionId: string; returnPath: string }
> {
  assertValidInstant(input.now);
  const stateHash = hashOpaqueToken(input.state, "external_link_state");
  if (input.userId && input.sessionId) {
    const [claimed] = await db
      .update(identityExternalLinkTransactions)
      .set({
        status: "processing",
        resultCode: "callback_claimed",
        consumedAt: input.now,
        expiresAt: new Date(input.now.getTime() + EXTERNAL_LINK_PROCESSING_LEASE_MS),
        updatedAt: input.now,
      })
      .where(
        and(
          eq(identityExternalLinkTransactions.stateHash, stateHash),
          eq(identityExternalLinkTransactions.userId, input.userId),
          eq(identityExternalLinkTransactions.sessionId, input.sessionId),
          eq(identityExternalLinkTransactions.provider, input.provider),
          eq(identityExternalLinkTransactions.status, "pending"),
          gt(identityExternalLinkTransactions.expiresAt, input.now),
        ),
      )
      .returning({
        id: identityExternalLinkTransactions.id,
        userId: identityExternalLinkTransactions.userId,
        sessionId: identityExternalLinkTransactions.sessionId,
        returnPath: identityExternalLinkTransactions.returnPath,
      });
    if (claimed) return { kind: "claimed", ...claimed };
  }

  const [existing] = await db
    .select({ id: identityExternalLinkTransactions.id })
    .from(identityExternalLinkTransactions)
    .where(eq(identityExternalLinkTransactions.stateHash, stateHash))
    .limit(1);
  return existing ? { kind: "invalid" } : { kind: "not_found" };
}

export async function finalizeExternalLinkTransaction(
  db: PawketDatabase | PawketTransaction,
  input: {
    id: string;
    outcome: "completed" | "conflict";
    resultCode: string;
    now: Date;
  },
): Promise<boolean> {
  assertValidInstant(input.now);
  if (!/^[a-z][a-z0-9_]{1,63}$/u.test(input.resultCode)) {
    throw new Error("Invalid external identity result");
  }
  const [finalized] = await db
    .update(identityExternalLinkTransactions)
    .set({ status: input.outcome, resultCode: input.resultCode, updatedAt: input.now })
    .where(
      and(
        eq(identityExternalLinkTransactions.id, input.id),
        eq(identityExternalLinkTransactions.status, "processing"),
      ),
    )
    .returning({ id: identityExternalLinkTransactions.id });
  return Boolean(finalized);
}

export async function consumeTotpStep(
  db: PawketDatabase | PawketTransaction,
  input: { userId: string; step: number; now: Date },
): Promise<boolean> {
  assertValidInstant(input.now);
  if (!Number.isSafeInteger(input.step) || input.step < 0) return false;
  const [updated] = await db
    .update(identityTotpAuthenticators)
    .set({ lastUsedStep: input.step, updatedAt: input.now })
    .where(
      and(
        eq(identityTotpAuthenticators.userId, input.userId),
        eq(identityTotpAuthenticators.verified, true),
        or(
          isNull(identityTotpAuthenticators.lastUsedStep),
          lt(identityTotpAuthenticators.lastUsedStep, input.step),
        ),
      ),
    )
    .returning({ id: identityTotpAuthenticators.id });
  return Boolean(updated);
}

export async function createRecoveryCodeBatch(
  db: PawketDatabase,
  input: { authenticatorId: string; now: Date },
): Promise<{ batchId: string; codes: string[] }> {
  assertValidInstant(input.now);
  const batchId = randomUUID();
  const codes = Array.from({ length: 10 }, generateRecoveryCode);
  await db.transaction((tx) =>
    replaceRecoveryCodeBatch(tx, { ...input, batchId, codes }),
  );
  return { batchId, codes };
}

async function replaceRecoveryCodeBatch(
  tx: PawketTransaction,
  input: {
    authenticatorId: string;
    now: Date;
    batchId: string;
    codes: string[];
  },
): Promise<void> {
  const [authenticator] = await tx
      .select({ id: identityTotpAuthenticators.id })
      .from(identityTotpAuthenticators)
      .where(
        and(
          eq(identityTotpAuthenticators.id, input.authenticatorId),
          eq(identityTotpAuthenticators.verified, true),
        ),
      )
      .limit(1);
  if (!authenticator) throw new Error("Active TOTP authenticator required");
  await tx
    .delete(identityRecoveryCodes)
    .where(eq(identityRecoveryCodes.authenticatorId, input.authenticatorId));
  await tx.insert(identityRecoveryCodes).values(
    input.codes.map((code) => ({
      authenticatorId: input.authenticatorId,
      batchId: input.batchId,
      codeHash: recoveryCodeHash(code),
      createdAt: input.now,
    })),
  );
}

export async function createRecoveryCodeBatchInTransaction(
  tx: PawketTransaction,
  input: { authenticatorId: string; now: Date },
): Promise<{ batchId: string; codes: string[] }> {
  assertValidInstant(input.now);
  const batchId = randomUUID();
  const codes = Array.from({ length: 10 }, generateRecoveryCode);
  await replaceRecoveryCodeBatch(tx, { ...input, batchId, codes });
  return { batchId, codes };
}

export async function consumeRecoveryCode(
  db: PawketDatabase | PawketTransaction,
  input: { authenticatorId: string; code: string; now: Date },
): Promise<boolean> {
  assertValidInstant(input.now);
  let hash: string;
  try {
    hash = recoveryCodeHash(input.code);
  } catch {
    return false;
  }
  const [consumed] = await db
    .update(identityRecoveryCodes)
    .set({ consumedAt: input.now })
    .where(
      and(
        eq(identityRecoveryCodes.authenticatorId, input.authenticatorId),
        eq(identityRecoveryCodes.codeHash, hash),
        isNull(identityRecoveryCodes.consumedAt),
      ),
    )
    .returning({ id: identityRecoveryCodes.id });
  return Boolean(consumed);
}

export async function recoveryCodeAvailable(
  db: PawketDatabase | PawketTransaction,
  input: { authenticatorId: string; code: string },
): Promise<boolean> {
  let hash: string;
  try {
    hash = recoveryCodeHash(input.code);
  } catch {
    return false;
  }
  const [available] = await db
    .select({ id: identityRecoveryCodes.id })
    .from(identityRecoveryCodes)
    .where(
      and(
        eq(identityRecoveryCodes.authenticatorId, input.authenticatorId),
        eq(identityRecoveryCodes.codeHash, hash),
        isNull(identityRecoveryCodes.consumedAt),
      ),
    )
    .limit(1);
  return Boolean(available);
}

export async function createStepUpProof(
  db: PawketDatabase,
  input: {
    sessionId: string;
    userId: string;
    actionClass: string;
    assuranceMethod: StepUpMethod;
    now: Date;
    lifetimeMs?: number;
  },
): Promise<{ id: string; expiresAt: Date }> {
  assertValidInstant(input.now);
  if (input.actionClass.startsWith("owner.") && input.assuranceMethod !== "totp") {
    throw new Error("Owner action requires TOTP assurance");
  }
  const maximumLifetime = input.actionClass.startsWith("owner.") ? 5 * 60_000 : 15 * 60_000;
  const lifetimeMs = input.lifetimeMs ?? maximumLifetime;
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 30_000 || lifetimeMs > maximumLifetime) {
    throw new Error("Invalid step-up lifetime");
  }

  const [session] = await db
    .select({
      primaryAuthenticatedAt: identitySessions.primaryAuthenticatedAt,
      mfaVerifiedAt: identitySessions.mfaVerifiedAt,
    })
    .from(identitySessions)
    .innerJoin(identityUsers, eq(identityUsers.id, identitySessions.userId))
    .where(
      and(
        eq(identitySessions.id, input.sessionId),
        eq(identitySessions.userId, input.userId),
        eq(identitySessions.assuranceState, "active"),
        isNull(identitySessions.revokedAt),
        gt(identitySessions.expiresAt, input.now),
        gt(identitySessions.idleExpiresAt, input.now),
        gt(identitySessions.absoluteExpiresAt, input.now),
        eq(identitySessions.authorizationVersion, identityUsers.authorizationVersion),
        eq(identityUsers.accessStatus, "active"),
        eq(identityUsers.emailVerified, true),
      ),
    )
    .limit(1);
  if (!session) throw new Error("Active session required");
  if (input.actionClass.startsWith("owner.") && !(await resolveOwnerPermission(db, input.userId))) {
    throw new Error("Owner permission required");
  }

  const assuranceAt =
    input.assuranceMethod === "primary"
      ? session.primaryAuthenticatedAt
      : session.mfaVerifiedAt;
  if (!assuranceAt || input.now.getTime() - assuranceAt.getTime() > maximumLifetime) {
    throw new Error("Recent authentication required");
  }

  const expiresAt = new Date(input.now.getTime() + lifetimeMs);
  const [proof] = await db
    .insert(identityStepUpProofs)
    .values({
      sessionId: input.sessionId,
      userId: input.userId,
      actionClass: input.actionClass,
      assuranceMethod: input.assuranceMethod,
      issuedAt: input.now,
      expiresAt,
    })
    .returning({ id: identityStepUpProofs.id });
  if (!proof) throw new Error("Failed to issue step-up proof");
  return { id: proof.id, expiresAt };
}

export async function consumeStepUpProof(
  db: PawketDatabase | PawketTransaction,
  input: {
    proofId: string;
    sessionId: string;
    userId: string;
    actionClass: string;
    now: Date;
  },
): Promise<boolean> {
  assertValidInstant(input.now);
  const activeSession = db
    .select({ value: sql<number>`1` })
    .from(identitySessions)
    .innerJoin(identityUsers, eq(identityUsers.id, identitySessions.userId))
    .where(
      and(
        eq(identitySessions.id, input.sessionId),
        eq(identitySessions.userId, input.userId),
        eq(identitySessions.assuranceState, "active"),
        isNull(identitySessions.revokedAt),
        gt(identitySessions.expiresAt, input.now),
        gt(identitySessions.idleExpiresAt, input.now),
        gt(identitySessions.absoluteExpiresAt, input.now),
        eq(identitySessions.authorizationVersion, identityUsers.authorizationVersion),
        eq(identityUsers.accessStatus, "active"),
        eq(identityUsers.emailVerified, true),
      ),
    );
  const currentOwner = db
    .select({ value: sql<number>`1` })
    .from(identityRoleGrants)
    .innerJoin(identityUsers, eq(identityUsers.id, identityRoleGrants.userId))
    .innerJoin(
      identityTotpAuthenticators,
      eq(identityTotpAuthenticators.userId, identityRoleGrants.userId),
    )
    .where(
      and(
        eq(identityRoleGrants.userId, input.userId),
        eq(identityRoleGrants.role, "owner"),
        eq(identityRoleGrants.state, "active"),
        eq(identityUsers.accessStatus, "active"),
        eq(identityUsers.emailVerified, true),
        eq(identityUsers.twoFactorEnabled, true),
        eq(identityTotpAuthenticators.verified, true),
      ),
    );
  const ownerAction = input.actionClass.startsWith("owner.");
  const [consumed] = await db
    .update(identityStepUpProofs)
    .set({ consumedAt: input.now })
    .where(
      and(
        eq(identityStepUpProofs.id, input.proofId),
        eq(identityStepUpProofs.sessionId, input.sessionId),
        eq(identityStepUpProofs.userId, input.userId),
        eq(identityStepUpProofs.actionClass, input.actionClass),
        isNull(identityStepUpProofs.consumedAt),
        gt(identityStepUpProofs.expiresAt, input.now),
        exists(activeSession),
        ...(ownerAction
          ? [eq(identityStepUpProofs.assuranceMethod, "totp"), exists(currentOwner)]
          : []),
      ),
    )
    .returning({ id: identityStepUpProofs.id });
  return Boolean(consumed);
}

export async function resolveOwnerPermission(
  db: PawketDatabase,
  userId: string,
): Promise<boolean> {
  const [owner] = await db
    .select({ id: identityRoleGrants.id })
    .from(identityRoleGrants)
    .innerJoin(identityUsers, eq(identityUsers.id, identityRoleGrants.userId))
    .innerJoin(
      identityTotpAuthenticators,
      eq(identityTotpAuthenticators.userId, identityRoleGrants.userId),
    )
    .where(
      and(
        eq(identityRoleGrants.userId, userId),
        eq(identityRoleGrants.role, "owner"),
        eq(identityRoleGrants.state, "active"),
        eq(identityUsers.accessStatus, "active"),
        eq(identityUsers.emailVerified, true),
        eq(identityUsers.twoFactorEnabled, true),
        eq(identityTotpAuthenticators.verified, true),
      ),
    )
    .limit(1);
  return Boolean(owner);
}
