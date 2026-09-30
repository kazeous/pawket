
import { readdir, readFile } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { identityEmailHandoffs, identityEmailAddresses, identityUsers, systemOutbox, type PawketDatabase } from "@pawket/database";
import { createEncryptionKeyring, type EncryptionKeyring } from "@pawket/security";
import * as schema from "@pawket/database";
import * as identity from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for identity integration tests");

type IdentityRepository = {
  issueVerificationChallenge(
    tx: Parameters<Parameters<PawketDatabase["transaction"]>[0]>[0],
    input: {
      id: string;
      userId: string;
      purpose: "email_verification" | "password_reset" | "email_change";
      identifierHash: string;
      token: string;
      targetEmailCanonical?: string;
      now: Date;
      expiresAt: Date;
    },
  ): Promise<void>;
  consumeVerificationChallenge(
    db: PawketDatabase,
    input: {
      purpose: "email_verification" | "password_reset" | "email_change";
      token: string;
      now: Date;
    },
  ): Promise<{ id: string; userId: string; targetEmailCanonical: string | null } | null>;
  createAuthoritativeSession(
    tx: Parameters<Parameters<PawketDatabase["transaction"]>[0]>[0],
    input: {
      id: string;
      userId: string;
      token: string;
      kind: "user" | "owner" | "provisional" | "mfa_pending";
      authorizationVersion: number;
      now: Date;
      networkKey?: string;
      userAgent?: string;
    },
  ): Promise<void>;
  resolveAuthoritativeSession(
    db: PawketDatabase,
    input: { token: string; now: Date },
  ): Promise<{
    sessionId: string;
    userId: string;
    emailVerified: boolean;
    accessStatus: "active";
    assuranceState: string;
  } | null>;
  resolveAuthoritativeSessionById(
    db: PawketDatabase,
    input: { sessionId: string; userId: string; now: Date },
  ): Promise<{
    sessionId: string;
    userId: string;
    primaryAuthenticatedAt: Date;
  } | null>;
  listUserSessions(
    db: PawketDatabase,
    input: { userId: string; now: Date },
  ): Promise<Array<{ id: string; deviceLabel: string; createdAt: Date; lastUsedAt: Date }>>;
  revokeUserSession(
    db: PawketDatabase,
    input: { userId: string; sessionId: string; reason: string; now: Date },
  ): Promise<boolean>;
  recordSecurityThrottleAttempt(
    db: PawketDatabase,
    input: {
      scope: "account" | "network";
      subjectHmac: string;
      action: string;
      now: Date;
      windowMs: number;
      maximumAttempts: number;
      blockMs: number;
    },
  ): Promise<{ allowed: boolean; attemptCount: number; retryAt: Date | null; risk: string }>;
  getIdentityUserSummary(
    db: PawketDatabase,
    userId: string,
  ): Promise<{
    id: string;
    displayName: string;
    displayEmail: string;
    emailVerified: boolean;
    accessStatus: string;
  } | null>;
  getTotpSecurityState(
    db: PawketDatabase,
    userId: string,
  ): Promise<{ enabled: boolean } | null>;
  queueSecurityEmailHandoff(
    tx: Parameters<Parameters<PawketDatabase["transaction"]>[0]>[0],
    input: {
      id: string;
      userId: string;
      purpose: "security_notice";
      destination: string;
      secret: string | null;
      templateData: Record<string, string>;
      keyring: EncryptionKeyring;
      now: Date;
    },
  ): Promise<string>;
  deliverSecurityEmailHandoff(
    db: PawketDatabase,
    input: {
      handoffId: string;
      workerId: string;
      keyring: EncryptionKeyring;
      sender: {
        send(message: {
          handoffId: string;
          purpose: "security_notice";
          destination: string;
          secret: string | null;
          templateData: Readonly<Record<string, string>>;
        }): Promise<void>;
      };
      now: Date;
    },
  ): Promise<"delivered" | "already_delivered">;
};

const repository = identity as unknown as Partial<IdentityRepository>;
const schemaName = `identity_repo_${process.pid}_${Date.now()}`;
const client = postgres(databaseUrl, { max: 1 });
const db = drizzle(client, { schema }) as PawketDatabase;
const migrationsDirectory = new URL("../../database/migrations/", import.meta.url);
const now = new Date("2026-08-24T01:00:00.000Z");

async function executeMigration(filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.unsafe(statement);
  }
}

beforeAll(async () => {
  await client.unsafe(`create schema "${schemaName}"`);
  await client.unsafe(`set search_path to "${schemaName}", public`);
  const migrations = (await readdir(migrationsDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  for (const migration of migrations) await executeMigration(migration);
  await db.insert(identityUsers).values({
    id: "user-1",
    name: "Artist",
    email: "Artist@example.com",
    canonicalEmail: "artist@example.com",
    emailVerified: true,
    emailVerifiedAt: now,
    emailVerificationProvenance: "password_email_challenge",
    accessStatus: "active",
    authorizationVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(identityEmailAddresses).values({
    userId: "user-1",
    displayEmail: "Artist@example.com",
    canonicalEmail: "artist@example.com",
    status: "primary",
    verifiedAt: now,
    verificationProvenance: "password_email_challenge",
    createdAt: now,
    updatedAt: now,
  });
});

afterAll(async () => {
  await client.unsafe("set search_path to public");
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.end();
});

describe("identity repository", () => {

  test("uses PostgreSQL as the authoritative account/network throttle", async () => {
    expect(typeof repository.recordSecurityThrottleAttempt).toBe("function");
    const input = {
      scope: "account" as const,
      subjectHmac: "hmac-sha256:v1:account",
      action: "password_sign_in",
      now,
      windowMs: 60_000,
      maximumAttempts: 2,
      blockMs: 120_000,
    };
    await expect(repository.recordSecurityThrottleAttempt!(db, input)).resolves.toMatchObject({
      allowed: true,
      attemptCount: 1,
      retryAt: null,
      risk: "normal",
    });
    await expect(repository.recordSecurityThrottleAttempt!(db, input)).resolves.toMatchObject({
      allowed: true,
      attemptCount: 2,
      risk: "elevated",
    });
    await expect(repository.recordSecurityThrottleAttempt!(db, input)).resolves.toMatchObject({
      allowed: false,
      attemptCount: 3,
      retryAt: new Date(now.getTime() + 120_000),
      risk: "challenge_required",
    });
  });

  test("queues only a purpose-bound handoff id and decrypts the private destination only for delivery", async () => {
    expect(typeof repository.queueSecurityEmailHandoff).toBe("function");
    expect(typeof repository.deliverSecurityEmailHandoff).toBe("function");
    const handoffId = "9fed3abd-ec32-462b-ad0b-366babf979c3";
    const destination = "artist@example.com";
    const secret = null;
    const keyring = createEncryptionKeyring({
      activeKeyId: "test-v1",
      keys: { "test-v1": Uint8Array.from({ length: 32 }, (_, index) => index + 1) },
    });

    await db.transaction((tx) =>
      repository.queueSecurityEmailHandoff!(tx, {
        id: handoffId,
        userId: "user-1",
        purpose: "security_notice",
        destination,
        secret,
        templateData: { event: "session_revoked", returnPath: "/settings/security" },
        keyring,
        now,
      }),
    );

    const [handoff] = await db
      .select()
      .from(identityEmailHandoffs)
      .where(eq(identityEmailHandoffs.id, handoffId));
    const [event] = await db
      .select()
      .from(systemOutbox)
      .where(eq(systemOutbox.aggregateId, handoffId));
    expect(JSON.stringify(handoff)).not.toMatch(/artist@example\.com|raw-reset-token/u);
    expect(event?.payload).toEqual({ handoffId, purpose: "security_notice" });
    expect(JSON.stringify(event)).not.toMatch(/artist@example\.com|raw-reset-token/u);

    const deliveries: unknown[] = [];
    const sender = {
      async send(message: unknown) {
        deliveries.push(message);
      },
    };
    await expect(
      repository.deliverSecurityEmailHandoff!(db, {
        handoffId,
        workerId: "worker-1",
        keyring,
        sender,
        now: new Date(now.getTime() + 1_000),
      }),
    ).resolves.toBe("delivered");
    expect(deliveries).toEqual([
      {
        handoffId,
        purpose: "security_notice",
        destination,
        secret,
        templateData: { event: "session_revoked", returnPath: "/settings/security" },
      },
    ]);
    await expect(
      repository.deliverSecurityEmailHandoff!(db, {
        handoffId,
        workerId: "worker-2",
        keyring,
        sender,
        now: new Date(now.getTime() + 2_000),
      }),
    ).resolves.toBe("already_delivered");
    expect(deliveries).toHaveLength(1);
  });
});
