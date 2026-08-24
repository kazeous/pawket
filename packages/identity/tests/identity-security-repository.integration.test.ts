import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  identityRoleGrants,
  identitySessions,
  identityTotpAuthenticators,
  identityUsers,
  type PawketDatabase,
} from "@pawket/database";
import * as schema from "@pawket/database";
import { createEncryptionKeyring, encryptSensitiveField } from "@pawket/security";

import {
  beginExternalLinkTransaction,
  claimExternalLinkTransaction,
  consumeRecoveryCode,
  consumeStepUpProof,
  consumeTotpStep,
  createRecoveryCodeBatch,
  createStepUpProof,
  finishExternalLinkTransaction,
  finalizeExternalLinkTransaction,
  resolveOwnerPermission,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for identity integration tests");

const schemaName = `identity_security_repository_${process.pid}_${Date.now()}`;
const client = postgres(databaseUrl, {
  max: 5,
  connection: { search_path: `${schemaName},public` },
});
const db = drizzle(client, { schema }) as PawketDatabase;
const migrationsDirectory = new URL("../../database/migrations/", import.meta.url);
const now = new Date("2026-08-24T03:00:00.000Z");

async function executeMigration(filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.unsafe(statement);
  }
}

beforeAll(async () => {
  await client.unsafe(`create schema "${schemaName}"`);
  await client.unsafe(`set search_path to "${schemaName}", public`);
  for (const migration of (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort()) {
    await executeMigration(migration);
  }

  await db.insert(identityUsers).values({
    id: "security-user",
    name: "Security Artist",
    email: "security@example.com",
    canonicalEmail: "security@example.com",
    emailVerified: true,
    emailVerifiedAt: now,
    emailVerificationProvenance: "password_email_challenge",
    twoFactorEnabled: true,
    accessStatus: "active",
    authorizationVersion: 1,
  });
  await db.insert(identitySessions).values({
    id: "security-session",
    token: "sha256:test-security-session",
    userId: "security-user",
    expiresAt: new Date(now.getTime() + 30 * 60_000),
    assuranceState: "active",
    primaryAuthenticatedAt: now,
    mfaVerifiedAt: now,
    lastUsedAt: now,
    absoluteExpiresAt: new Date(now.getTime() + 12 * 60 * 60_000),
    idleExpiresAt: new Date(now.getTime() + 30 * 60_000),
    authorizationVersion: 1,
    createdAt: now,
    updatedAt: now,
  });

  const authenticatorId = "security-authenticator";
  const keyring = createEncryptionKeyring({
    activeKeyId: "test-v1",
    keys: { "test-v1": Uint8Array.from({ length: 32 }, (_, index) => index + 1) },
  });
  await db.insert(identityTotpAuthenticators).values({
    id: authenticatorId,
    userId: "security-user",
    secret: encryptSensitiveField({
      plaintext: "library-encrypted-totp-seed",
      binding: {
        recordType: "identity_totp_authenticator",
        recordId: authenticatorId,
        fieldName: "secret",
      },
      keyring,
    }),
    verified: true,
  });
});

afterAll(async () => {
  await client.unsafe("set search_path to public");
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.end();
});

describe("identity security repository", () => {
  test("binds and consumes an external-link state exactly once", async () => {
    const begun = await beginExternalLinkTransaction(db, {
      userId: "security-user",
      sessionId: "security-session",
      provider: "google",
      returnPath: "/settings/security",
      now,
    });

    await expect(
      finishExternalLinkTransaction(db, {
        state: begun.state,
        userId: "security-user",
        sessionId: "security-session",
        provider: "discord",
        outcome: "completed",
        resultCode: "linked",
        now: new Date(now.getTime() + 1_000),
      }),
    ).resolves.toBeNull();
    await expect(
      finishExternalLinkTransaction(db, {
        state: begun.state,
        userId: "security-user",
        sessionId: "security-session",
        provider: "google",
        outcome: "completed",
        resultCode: "linked",
        now: new Date(now.getTime() + 1_000),
      }),
    ).resolves.toMatchObject({ status: "completed", resultCode: "linked" });
    await expect(
      finishExternalLinkTransaction(db, {
        state: begun.state,
        userId: "security-user",
        sessionId: "security-session",
        provider: "google",
        outcome: "completed",
        resultCode: "linked",
        now: new Date(now.getTime() + 2_000),
      }),
    ).resolves.toBeNull();
  });

  test("serializes concurrent link starts for the same user and provider", async () => {
    const attempts = await Promise.allSettled([
      beginExternalLinkTransaction(db, {
        userId: "security-user",
        sessionId: "security-session",
        provider: "google",
        returnPath: "/settings/security",
        now: new Date(now.getTime() + 3_000),
      }),
      beginExternalLinkTransaction(db, {
        userId: "security-user",
        sessionId: "security-session",
        provider: "google",
        returnPath: "/settings/security",
        now: new Date(now.getTime() + 3_000),
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const begun = attempts.find(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof beginExternalLinkTransaction>>> =>
        attempt.status === "fulfilled",
    );
    if (!begun) throw new Error("Expected one serialized link transaction");
    await expect(
      finishExternalLinkTransaction(db, {
        state: begun.value.state,
        userId: "security-user",
        sessionId: "security-session",
        provider: "google",
        outcome: "conflict",
        resultCode: "test_cleanup",
        now: new Date(now.getTime() + 4_000),
      }),
    ).resolves.toMatchObject({ status: "conflict" });
  });

  test("extends a claimed callback lease across the original state expiry", async () => {
    const begunAt = new Date(now.getTime() + 10_000);
    const begun = await beginExternalLinkTransaction(db, {
      userId: "security-user",
      sessionId: "security-session",
      provider: "google",
      returnPath: "/settings/security",
      now: begunAt,
      lifetimeMs: 60_000,
    });
    const claimed = await claimExternalLinkTransaction(db, {
      state: begun.state,
      userId: "security-user",
      sessionId: "security-session",
      provider: "google",
      now: new Date(begunAt.getTime() + 59_900),
    });
    if (claimed.kind !== "claimed") throw new Error("Expected callback processing lease");
    await expect(
      beginExternalLinkTransaction(db, {
        userId: "security-user",
        sessionId: "security-session",
        provider: "google",
        returnPath: "/settings/security",
        now: new Date(begunAt.getTime() + 60_100),
      }),
    ).rejects.toThrow("already active");
    await expect(
      finalizeExternalLinkTransaction(db, {
        id: claimed.id,
        outcome: "conflict",
        resultCode: "test_cleanup",
        now: new Date(begunAt.getTime() + 60_200),
      }),
    ).resolves.toBe(true);
  });

  test("atomically claims a callback before provider exchange and finalizes it once", async () => {
    const begun = await beginExternalLinkTransaction(db, {
      userId: "security-user",
      sessionId: "security-session",
      provider: "discord",
      returnPath: "/settings/security",
      now,
    });
    await expect(
      claimExternalLinkTransaction(db, {
        state: begun.state,
        userId: "security-user",
        sessionId: "security-session",
        provider: "google",
        now: new Date(now.getTime() + 1_000),
      }),
    ).resolves.toEqual({ kind: "invalid" });

    const claims = await Promise.all([
      claimExternalLinkTransaction(db, {
        state: begun.state,
        userId: "security-user",
        sessionId: "security-session",
        provider: "discord",
        now: new Date(now.getTime() + 2_000),
      }),
      claimExternalLinkTransaction(db, {
        state: begun.state,
        userId: "security-user",
        sessionId: "security-session",
        provider: "discord",
        now: new Date(now.getTime() + 2_000),
      }),
    ]);
    const claimed = claims.find((result) => result.kind === "claimed");
    expect(claims.filter((result) => result.kind === "claimed")).toHaveLength(1);
    expect(claims.filter((result) => result.kind === "invalid")).toHaveLength(1);
    if (!claimed || claimed.kind !== "claimed") throw new Error("Expected claimed callback");
    await expect(
      finalizeExternalLinkTransaction(db, {
        id: claimed.id,
        outcome: "completed",
        resultCode: "linked",
        now: new Date(now.getTime() + 3_000),
      }),
    ).resolves.toBe(true);
    await expect(
      finalizeExternalLinkTransaction(db, {
        id: claimed.id,
        outcome: "conflict",
        resultCode: "callback_rejected",
        now: new Date(now.getTime() + 4_000),
      }),
    ).resolves.toBe(false);
  });

  test("prevents concurrent replay of an accepted TOTP time step", async () => {
    const results = await Promise.all([
      consumeTotpStep(db, { userId: "security-user", step: 59_000_000, now }),
      consumeTotpStep(db, { userId: "security-user", step: 59_000_000, now }),
    ]);
    expect(results.sort()).toEqual([false, true]);
    await expect(
      consumeTotpStep(db, { userId: "security-user", step: 58_999_999, now }),
    ).resolves.toBe(false);
  });

  test("creates exactly ten hash-only recovery codes and atomically consumes each once", async () => {
    const first = await createRecoveryCodeBatch(db, {
      authenticatorId: "security-authenticator",
      now,
    });
    expect(first.codes).toHaveLength(10);

    const consumed = await Promise.all([
      consumeRecoveryCode(db, {
        authenticatorId: "security-authenticator",
        code: first.codes[0]!,
        now: new Date(now.getTime() + 1_000),
      }),
      consumeRecoveryCode(db, {
        authenticatorId: "security-authenticator",
        code: first.codes[0]!,
        now: new Date(now.getTime() + 1_000),
      }),
    ]);
    expect(consumed.sort()).toEqual([false, true]);

    const second = await createRecoveryCodeBatch(db, {
      authenticatorId: "security-authenticator",
      now: new Date(now.getTime() + 2_000),
    });
    await expect(
      consumeRecoveryCode(db, {
        authenticatorId: "security-authenticator",
        code: first.codes[1]!,
        now: new Date(now.getTime() + 3_000),
      }),
    ).resolves.toBe(false);
    await expect(
      consumeRecoveryCode(db, {
        authenticatorId: "security-authenticator",
        code: second.codes[0]!,
        now: new Date(now.getTime() + 3_000),
      }),
    ).resolves.toBe(true);
  });

  test("scopes step-up to session and action, and rejects recovery for owner actions", async () => {
    await db.insert(identityRoleGrants).values({
      id: randomUUID(),
      userId: "security-user",
      role: "owner",
      state: "active",
      grantSource: "bootstrap_cli",
      grantedAt: now,
    });
    await expect(
      createStepUpProof(db, {
        sessionId: "security-session",
        userId: "security-user",
        actionClass: "owner.creator_decision",
        assuranceMethod: "recovery",
        now,
      }),
    ).rejects.toThrow();

    const proof = await createStepUpProof(db, {
      sessionId: "security-session",
      userId: "security-user",
      actionClass: "owner.creator_decision",
      assuranceMethod: "totp",
      now,
    });
    await expect(
      consumeStepUpProof(db, {
        proofId: proof.id,
        sessionId: "security-session",
        userId: "security-user",
        actionClass: "owner.refund",
        now: new Date(now.getTime() + 1_000),
      }),
    ).resolves.toBe(false);
    await expect(
      consumeStepUpProof(db, {
        proofId: proof.id,
        sessionId: "security-session",
        userId: "security-user",
        actionClass: "owner.creator_decision",
        now: new Date(now.getTime() + 1_000),
      }),
    ).resolves.toBe(true);
    await expect(
      consumeStepUpProof(db, {
        proofId: proof.id,
        sessionId: "security-session",
        userId: "security-user",
        actionClass: "owner.creator_decision",
        now: new Date(now.getTime() + 2_000),
      }),
    ).resolves.toBe(false);

    const transactionalProof = await createStepUpProof(db, {
      sessionId: "security-session",
      userId: "security-user",
      actionClass: "owner.creator_decision",
      assuranceMethod: "totp",
      now: new Date(now.getTime() + 2_100),
    });
    await expect(
      db.transaction(async (tx) => {
        expect(
          await consumeStepUpProof(tx, {
            proofId: transactionalProof.id,
            sessionId: "security-session",
            userId: "security-user",
            actionClass: "owner.creator_decision",
            now: new Date(now.getTime() + 2_200),
          }),
        ).toBe(true);
        throw new Error("rollback privileged operation");
      }),
    ).rejects.toThrow("rollback privileged operation");
    await expect(
      consumeStepUpProof(db, {
        proofId: transactionalProof.id,
        sessionId: "security-session",
        userId: "security-user",
        actionClass: "owner.creator_decision",
        now: new Date(now.getTime() + 2_300),
      }),
    ).resolves.toBe(true);

    const staleProof = await createStepUpProof(db, {
      sessionId: "security-session",
      userId: "security-user",
      actionClass: "owner.creator_decision",
      assuranceMethod: "totp",
      now: new Date(now.getTime() + 3_000),
    });
    await db
      .update(identitySessions)
      .set({
        revokedAt: new Date(now.getTime() + 4_000),
        revocationReason: "security_test",
      })
      .where(eq(identitySessions.id, "security-session"));
    await expect(
      consumeStepUpProof(db, {
        proofId: staleProof.id,
        sessionId: "security-session",
        userId: "security-user",
        actionClass: "owner.creator_decision",
        now: new Date(now.getTime() + 5_000),
      }),
    ).resolves.toBe(false);
  });

  test("resolves owner permission only for an active verified user with TOTP", async () => {
    await expect(resolveOwnerPermission(db, "security-user")).resolves.toBe(true);
  });
});
