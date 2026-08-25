import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  adminAuditEvents,
  identityEmailHandoffs,
  identityRecoveryCodes,
  identityRoleGrants,
  identitySessions,
  identityTotpAuthenticators,
  identityUsers,
  systemOutbox,
  systemCommandIdempotency,
  type PawketDatabase,
} from "@pawket/database";
import * as schema from "@pawket/database";
import { createEncryptionKeyring, encryptSensitiveField } from "@pawket/security";

import {
  bootstrapOwner,
  ownerBootstrapConfirmation,
  ownerMfaRecoveryConfirmation,
  recoverOwnerMfa,
  resolveOwnerSessionPermission,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for admin integration tests");

const schemaName = `admin_owner_bootstrap_${process.pid}_${Date.now()}`;
const client = postgres(databaseUrl, {
  max: 5,
  connection: { search_path: `${schemaName},public` },
});
const db = drizzle(client, { schema }) as PawketDatabase;
const migrationsDirectory = new URL("../../database/migrations/", import.meta.url);
const now = new Date("2026-08-24T06:00:00.000Z");
const keyring = createEncryptionKeyring({
  activeKeyId: "test-v1",
  keys: { "test-v1": Uint8Array.from({ length: 32 }, (_, index) => index + 1) },
});

async function executeMigration(filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.unsafe(statement);
  }
}

async function insertEligibleUser(id: string, email: string): Promise<void> {
  await db.insert(identityUsers).values({
    id,
    name: "Pawket Owner",
    email,
    canonicalEmail: email.toLowerCase(),
    emailVerified: true,
    emailVerifiedAt: now,
    emailVerificationProvenance: "password_email_challenge",
    accessStatus: "active",
    authorizationVersion: 3,
  });
}

async function insertSession(id: string, userId: string): Promise<void> {
  await db.insert(identitySessions).values({
    id,
    token: `sha256:${id}`,
    userId,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + 30 * 60_000),
    assuranceState: "active",
    primaryAuthenticatedAt: now,
    lastUsedAt: now,
    absoluteExpiresAt: new Date(now.getTime() + 12 * 60 * 60_000),
    idleExpiresAt: new Date(now.getTime() + 30 * 60_000),
    authorizationVersion: 3,
  });
}

function bootstrapInput(userId = "owner-user") {
  return {
    userId,
    configuredEmail: "Owner@Example.com",
    confirmation: ownerBootstrapConfirmation(userId),
    applicationRevision: "task3-test-revision",
    confirmedApplicationRevision: "task3-test-revision",
    requestId: `bootstrap:${userId}`,
    keyring,
    now,
  };
}

beforeAll(async () => {
  await client.unsafe(`create schema "${schemaName}"`);
  await client.unsafe(`set search_path to "${schemaName}", public`);
  for (const migration of (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort()) {
    await executeMigration(migration);
  }
});

beforeEach(async () => {
  await client.unsafe(`truncate table
    admin_audit_events,
    identity_email_handoffs,
    identity_role_grants,
    identity_sessions,
    identity_totp_authenticators,
    system_command_idempotency,
    identity_email_addresses,
    identity_accounts,
    identity_users,
    system_outbox
    restart identity cascade`);
});

afterAll(async () => {
  await client.unsafe("set search_path to public");
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.end();
});

describe("one-shot owner bootstrap", () => {
  test("refuses unsafe preconditions without mutating privileged state", async () => {
    await insertEligibleUser("owner-user", "owner@example.com");

    await expect(
      bootstrapOwner(db, { ...bootstrapInput(), configuredEmail: "different@example.com" }),
    ).rejects.toMatchObject({ code: "OWNER_EMAIL_MISMATCH" });
    await expect(
      bootstrapOwner(db, { ...bootstrapInput(), confirmation: "BOOTSTRAP_OWNER" }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    await expect(
      bootstrapOwner(db, {
        ...bootstrapInput(),
        confirmedApplicationRevision: "different-revision",
      }),
    ).rejects.toMatchObject({ code: "REVISION_MISMATCH" });

    const roles = await db.select().from(identityRoleGrants);
    const audits = await db.select().from(adminAuditEvents);
    expect(roles).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  test("atomically grants the only owner, revokes sessions, audits, and queues a notice", async () => {
    await insertEligibleUser("owner-user", "owner@example.com");
    await insertSession("session-one", "owner-user");
    await insertSession("session-two", "owner-user");

    await expect(bootstrapOwner(db, bootstrapInput())).resolves.toMatchObject({
      userId: "owner-user",
      authorizationVersion: 4,
      revokedSessionCount: 2,
    });

    const [user] = await db.select().from(identityUsers).where(eq(identityUsers.id, "owner-user"));
    const [grant] = await db.select().from(identityRoleGrants);
    const sessions = await db.select().from(identitySessions);
    const [audit] = await db.select().from(adminAuditEvents);
    const [handoff] = await db.select().from(identityEmailHandoffs);
    const [outbox] = await db.select().from(systemOutbox);

    expect(user?.authorizationVersion).toBe(4);
    expect(grant).toMatchObject({
      userId: "owner-user",
      role: "owner",
      state: "active",
      grantSource: "bootstrap_cli",
      grantedByUserId: null,
    });
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.revocationReason === "owner_bootstrap")).toBe(true);
    expect(sessions.every((session) => session.revokedAt?.getTime() === now.getTime())).toBe(true);
    expect(audit).toMatchObject({
      actorUserId: "owner-user",
      actorSessionId: null,
      subjectType: "identity_user",
      subjectId: "owner-user",
      action: "identity.owner_bootstrapped",
      outcome: "succeeded",
      reasonCode: "bootstrap_cli",
      applicationRevision: "task3-test-revision",
      requestId: "bootstrap:owner-user",
    });
    expect(handoff).toMatchObject({
      userId: "owner-user",
      purpose: "security_notice",
      status: "pending",
      templateData: { event: "owner_bootstrap_completed", returnPath: "/settings/security" },
    });
    expect(outbox).toMatchObject({
      eventType: "identity.security_email.requested.v1",
      aggregateType: "security_email_handoff",
      aggregateId: handoff?.id,
    });
  });

  test("refuses rerun, replacement, and concurrent second-owner races", async () => {
    await insertEligibleUser("owner-user", "owner@example.com");
    await insertEligibleUser("second-user", "second@example.com");
    const race = await Promise.allSettled([
      bootstrapOwner(db, bootstrapInput()),
      bootstrapOwner(db, bootstrapInput()),
    ]);
    expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(race.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(race.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "OWNER_ALREADY_EXISTS" },
    });

    await expect(bootstrapOwner(db, bootstrapInput())).rejects.toMatchObject({
      code: "OWNER_ALREADY_EXISTS",
    });
    await expect(
      bootstrapOwner(db, {
        ...bootstrapInput("second-user"),
        configuredEmail: "second@example.com",
      }),
    ).rejects.toMatchObject({ code: "OWNER_ALREADY_EXISTS" });

    expect(await db.select().from(identityRoleGrants)).toHaveLength(1);
    expect(await db.select().from(adminAuditEvents)).toHaveLength(1);
  });

  test("keeps admin access closed until a new MFA-authenticated session exists", async () => {
    await insertEligibleUser("owner-user", "owner@example.com");
    await bootstrapOwner(db, bootstrapInput());

    await expect(
      resolveOwnerSessionPermission(db, { userId: "owner-user", sessionId: "missing", now }),
    ).resolves.toBe(false);

    const authenticatorId = randomUUID();
    await db.update(identityUsers).set({ twoFactorEnabled: true }).where(eq(identityUsers.id, "owner-user"));
    await db.insert(identityTotpAuthenticators).values({
      id: authenticatorId,
      userId: "owner-user",
      secret: encryptSensitiveField({
        plaintext: "owner-totp-seed",
        binding: {
          recordType: "identity_totp_authenticator",
          recordId: authenticatorId,
          fieldName: "secret",
        },
        keyring,
      }),
      verified: true,
    });
    await db.insert(identitySessions).values({
      id: "new-owner-session",
      token: "sha256:new-owner-session",
      userId: "owner-user",
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 30 * 60_000),
      assuranceState: "active",
      primaryAuthenticatedAt: now,
      mfaVerifiedAt: now,
      lastUsedAt: now,
      absoluteExpiresAt: new Date(now.getTime() + 12 * 60 * 60_000),
      idleExpiresAt: new Date(now.getTime() + 30 * 60_000),
      authorizationVersion: 4,
    });

    await expect(
      resolveOwnerSessionPermission(db, {
        userId: "owner-user",
        sessionId: "new-owner-session",
        now: new Date(now.getTime() + 60_000),
      }),
    ).resolves.toBe(true);

    await db
      .update(identitySessions)
      .set({ mfaVerifiedAt: null })
      .where(
        and(
          eq(identitySessions.id, "new-owner-session"),
          isNull(identitySessions.revokedAt),
        ),
      );
    await expect(
      resolveOwnerSessionPermission(db, {
        userId: "owner-user",
        sessionId: "new-owner-session",
        now: new Date(now.getTime() + 60_000),
      }),
    ).resolves.toBe(false);
  });

  test("break-glass recovery atomically invalidates MFA and sessions without changing the owner role", async () => {
    await insertEligibleUser("owner-user", "owner@example.com");
    await bootstrapOwner(db, bootstrapInput());
    const recoveryNow = new Date("2026-08-26T06:00:00.000Z");
    const authenticatorId = randomUUID();
    await db.update(identityUsers).set({ twoFactorEnabled: true }).where(eq(identityUsers.id, "owner-user"));
    await db.insert(identityTotpAuthenticators).values({
      id: authenticatorId,
      userId: "owner-user",
      secret: encryptSensitiveField({
        plaintext: "owner-totp-seed",
        binding: { recordType: "identity_totp_authenticator", recordId: authenticatorId, fieldName: "secret" },
        keyring,
      }),
      verified: true,
    });
    await db.insert(identityRecoveryCodes).values({
      authenticatorId,
      batchId: randomUUID(),
      codeHash: "sha256:recovery-code",
    });
    await insertSession("owner-breakglass-session", "owner-user");

    const input = {
      userId: "owner-user",
      configuredEmail: "owner@example.com",
      incidentId: "incident-42",
      repositoryEvidenceId: "repo-ticket-9",
      hostEvidenceId: "host-ticket-8",
      authorizedAt: new Date("2026-08-25T06:00:00.000Z"),
      confirmation: ownerMfaRecoveryConfirmation("owner-user", "incident-42"),
      applicationRevision: "task8-test-revision",
      keyring,
      now: recoveryNow,
    } as const;
    await expect(recoverOwnerMfa(db, input)).resolves.toMatchObject({
      authorizationVersion: 5,
      revokedSessionCount: 1,
      invalidatedAuthenticatorCount: 1,
    });

    const [user] = await db.select().from(identityUsers).where(eq(identityUsers.id, "owner-user"));
    const [session] = await db.select().from(identitySessions).where(eq(identitySessions.id, "owner-breakglass-session"));
    const roles = await db.select().from(identityRoleGrants);
    const audits = await db.select().from(adminAuditEvents);
    expect(user).toMatchObject({ twoFactorEnabled: false, authorizationVersion: 5 });
    expect(session?.revocationReason).toBe("owner_mfa_break_glass");
    expect(await db.select().from(identityTotpAuthenticators)).toHaveLength(0);
    expect(await db.select().from(identityRecoveryCodes)).toHaveLength(0);
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ userId: "owner-user", role: "owner", state: "active" });
    expect(audits.at(-1)).toMatchObject({
      action: "identity.owner_mfa_break_glass",
      reasonCode: "completed_wait_period",
      requestId: "breakglass:incident-42",
    });
    await expect(recoverOwnerMfa(db, input)).rejects.toMatchObject({
      code: "RECOVERY_ALREADY_USED",
    });
    expect(await db.select().from(systemCommandIdempotency)).toHaveLength(1);
  });

  test("break-glass recovery refuses missing independent evidence and an incomplete wait", async () => {
    await insertEligibleUser("owner-user", "owner@example.com");
    await bootstrapOwner(db, bootstrapInput());
    const recoveryNow = new Date("2026-08-25T06:00:00.000Z");
    const base = {
      userId: "owner-user",
      configuredEmail: "owner@example.com",
      incidentId: "incident-43",
      repositoryEvidenceId: "same-proof",
      hostEvidenceId: "same-proof",
      authorizedAt: new Date("2026-08-25T05:00:00.000Z"),
      confirmation: ownerMfaRecoveryConfirmation("owner-user", "incident-43"),
      applicationRevision: "task8-test-revision",
      keyring,
      now: recoveryNow,
    } as const;
    await expect(recoverOwnerMfa(db, base)).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED" });
    await expect(
      recoverOwnerMfa(db, { ...base, hostEvidenceId: "host-proof" }),
    ).rejects.toMatchObject({ code: "WAIT_PERIOD_REQUIRED" });
    await expect(
      recoverOwnerMfa(db, {
        ...base,
        hostEvidenceId: "host-proof",
        emergencyReason: "free_form" as "active_refund_deadline",
      }),
    ).rejects.toMatchObject({ code: "INVALID_RECOVERY_INPUT" });
    expect(await db.select().from(systemCommandIdempotency)).toHaveLength(0);
  });
});
