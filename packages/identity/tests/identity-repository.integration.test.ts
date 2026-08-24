import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  identityEmailHandoffs,
  identityEmailAddresses,
  identitySessions,
  identityUsers,
  identityVerifications,
  systemOutbox,
  type PawketDatabase,
} from "@pawket/database";
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
  queueSecurityEmailHandoff(
    tx: Parameters<Parameters<PawketDatabase["transaction"]>[0]>[0],
    input: {
      id: string;
      userId: string;
      purpose: "password_reset";
      destination: string;
      secret: string;
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
          purpose: "password_reset";
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
  test("stores only challenge hashes and permits exactly one concurrent consume", async () => {
    expect(typeof repository.issueVerificationChallenge).toBe("function");
    expect(typeof repository.consumeVerificationChallenge).toBe("function");
    const token = "raw-verification-token-that-must-never-be-stored";
    await db.transaction((tx) =>
      repository.issueVerificationChallenge!(tx, {
        id: "verification-1",
        userId: "user-1",
        purpose: "email_verification",
        identifierHash: "hmac-sha256:v1:identifier",
        token,
        targetEmailCanonical: "artist@example.com",
        now,
        expiresAt: new Date(now.getTime() + 30 * 60_000),
      }),
    );

    const [stored] = await db.select().from(identityVerifications);
    expect(stored?.value).not.toBe(token);
    expect(stored?.value).toMatch(/^sha256:v1:/u);

    const results = await Promise.all([
      repository.consumeVerificationChallenge!(db, {
        purpose: "email_verification",
        token,
        now: new Date(now.getTime() + 1_000),
      }),
      repository.consumeVerificationChallenge!(db, {
        purpose: "email_verification",
        token,
        now: new Date(now.getTime() + 1_000),
      }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("resolves sessions from current database state and revokes by safe session id", async () => {
    expect(typeof repository.createAuthoritativeSession).toBe("function");
    expect(typeof repository.resolveAuthoritativeSession).toBe("function");
    expect(typeof repository.resolveAuthoritativeSessionById).toBe("function");
    expect(typeof repository.listUserSessions).toBe("function");
    expect(typeof repository.revokeUserSession).toBe("function");
    expect(typeof repository.getIdentityUserSummary).toBe("function");
    const sessionId = randomUUID();
    const token = "opaque-browser-session-secret";
    await db.transaction((tx) =>
      repository.createAuthoritativeSession!(tx, {
        id: sessionId,
        userId: "user-1",
        token,
        kind: "user",
        authorizationVersion: 1,
        networkKey: "hmac-sha256:v1:network",
        userAgent: "Mozilla/5.0 Chrome/140.0.0.0",
        now,
      }),
    );

    const [stored] = await db.select().from(identitySessions).where(eq(identitySessions.id, sessionId));
    expect(stored?.token).not.toBe(token);
    await expect(repository.resolveAuthoritativeSession!(db, { token, now })).resolves.toMatchObject({
      sessionId,
      userId: "user-1",
      emailVerified: true,
      accessStatus: "active",
      assuranceState: "active",
    });
    await expect(
      repository.resolveAuthoritativeSessionById!(db, {
        sessionId,
        userId: "user-1",
        now,
      }),
    ).resolves.toEqual({
      sessionId,
      userId: "user-1",
      primaryAuthenticatedAt: now,
    });
    await expect(repository.getIdentityUserSummary!(db, "user-1")).resolves.toEqual({
      id: "user-1",
      displayName: "Artist",
      displayEmail: "Artist@example.com",
      emailVerified: true,
      accessStatus: "active",
    });
    await expect(repository.listUserSessions!(db, { userId: "user-1", now })).resolves.toEqual([
      {
        id: sessionId,
        deviceLabel: "Chrome",
        createdAt: now,
        lastUsedAt: now,
      },
    ]);
    await expect(
      repository.revokeUserSession!(db, {
        userId: "user-1",
        sessionId,
        reason: "user_requested",
        now: new Date(now.getTime() + 2_000),
      }),
    ).resolves.toBe(true);
    await expect(repository.resolveAuthoritativeSession!(db, { token, now })).resolves.toBeNull();
  });

  test("fails closed when current access status or authorization version changes", async () => {
    const token = "second-opaque-session-secret";
    await db.transaction((tx) =>
      repository.createAuthoritativeSession!(tx, {
        id: randomUUID(),
        userId: "user-1",
        token,
        kind: "user",
        authorizationVersion: 1,
        now,
      }),
    );
    await db
      .update(identityUsers)
      .set({ accessStatus: "access_suspended", authorizationVersion: 2, updatedAt: now })
      .where(eq(identityUsers.id, "user-1"));
    await expect(repository.resolveAuthoritativeSession!(db, { token, now })).resolves.toBeNull();
  });

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

  test("queues only a purpose-bound handoff id and decrypts secrets only for delivery", async () => {
    expect(typeof repository.queueSecurityEmailHandoff).toBe("function");
    expect(typeof repository.deliverSecurityEmailHandoff).toBe("function");
    const handoffId = "9fed3abd-ec32-462b-ad0b-366babf979c3";
    const destination = "artist@example.com";
    const secret = "raw-reset-token-that-must-not-enter-the-job";
    const keyring = createEncryptionKeyring({
      activeKeyId: "test-v1",
      keys: { "test-v1": Uint8Array.from({ length: 32 }, (_, index) => index + 1) },
    });

    await db.transaction((tx) =>
      repository.queueSecurityEmailHandoff!(tx, {
        id: handoffId,
        userId: "user-1",
        purpose: "password_reset",
        destination,
        secret,
        templateData: { returnPath: "/reset-password" },
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
    expect(event?.payload).toEqual({ handoffId, purpose: "password_reset" });
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
        purpose: "password_reset",
        destination,
        secret,
        templateData: { returnPath: "/reset-password" },
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
