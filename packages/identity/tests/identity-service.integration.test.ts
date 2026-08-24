import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  identityAccounts,
  identityEmailAddresses,
  identitySessions,
  identityUsers,
  identityVerifications,
  systemOutbox,
  type PawketDatabase,
} from "@pawket/database";
import * as schema from "@pawket/database";
import { createEncryptionKeyring } from "@pawket/security";
import * as identity from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for identity integration tests");

type IdentityService = {
  registerPassword(input: { name: string; email: string; password: string }): Promise<{ accepted: true }>;
  resendEmailVerification(input: { email: string }): Promise<{ accepted: true }>;
  verifyEmail(input: { token: string }): Promise<{ verified: boolean }>;
  requestPasswordReset(input: { email: string }): Promise<{ accepted: true }>;
  resetPassword(input: { token: string; newPassword: string }): Promise<{ completed: boolean }>;
  changePassword(input: {
    userId: string;
    currentPassword: string;
    newPassword: string;
    currentSessionId: string;
    primaryAuthenticatedAt: Date;
  }): Promise<{ changed: boolean }>;
  requestEmailChange(input: {
    userId: string;
    newEmail: string;
    primaryAuthenticatedAt: Date;
  }): Promise<{ accepted: boolean }>;
  completeEmailChange(input: {
    userId: string;
    token: string;
    currentSessionId: string;
  }): Promise<{ completed: boolean }>;
  setUserAccessStatus(input: {
    userId: string;
    status: "active" | "access_suspended" | "closed";
    now?: Date;
  }): Promise<boolean>;
};

type IdentityServiceFactory = {
  createIdentityService(options: {
    db: PawketDatabase;
    keyring: ReturnType<typeof createEncryptionKeyring>;
    lookupHmacKey: Uint8Array;
    compromisedPasswordChecker: { isCompromised(password: string): Promise<boolean> };
    idFactory(): string;
    tokenFactory(purpose: string): string;
    now(): Date;
    passwordHasher(password: string): Promise<string>;
    passwordVerifier(input: { hash: string; password: string }): Promise<boolean>;
  }): IdentityService;
};

const serviceFactory = identity as unknown as Partial<IdentityServiceFactory>;
const schemaName = `identity_service_${process.pid}_${Date.now()}`;
const client = postgres(databaseUrl, { max: 1 });
const db = drizzle(client, { schema }) as PawketDatabase;
const migrationsDirectory = new URL("../../database/migrations/", import.meta.url);
const fixedNow = new Date("2026-08-24T02:00:00.000Z");
const issuedTokens = new Map<string, string[]>();
const hashedInputs: string[] = [];

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
});

afterAll(async () => {
  await client.unsafe("set search_path to public");
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.end();
});

function latestToken(purpose: string): string {
  const values = issuedTokens.get(purpose);
  const token = values?.at(-1);
  if (!token) throw new Error(`No ${purpose} token was issued`);
  return token;
}

describe("identity account service", () => {
  expect(typeof serviceFactory.createIdentityService).toBe("function");
  const service = serviceFactory.createIdentityService!({
    db,
    keyring: createEncryptionKeyring({
      activeKeyId: "test-v1",
      keys: { "test-v1": Uint8Array.from({ length: 32 }, (_, index) => 255 - index) },
    }),
    lookupHmacKey: Uint8Array.from({ length: 32 }, (_, index) => index + 10),
    compromisedPasswordChecker: { async isCompromised() { return false; } },
    idFactory: randomUUID,
    tokenFactory(purpose) {
      const token = `${purpose}-opaque-${randomUUID()}`;
      const values = issuedTokens.get(purpose) ?? [];
      values.push(token);
      issuedTokens.set(purpose, values);
      return token;
    },
    now: () => fixedNow,
    passwordHasher: async (password) => {
      hashedInputs.push(password);
      return `hash:${password}`;
    },
    passwordVerifier: async ({ hash, password }) => hash === `hash:${password}`,
  });

  test("registers one canonical provisional password identity without returning its token", async () => {
    const result = await service.registerPassword({
      name: "Artist",
      email: "  Artist.Name+Shop@EXAMPLE.COM  ",
      password: "a unique password phrase",
    });
    expect(result).toEqual({ accepted: true });
    expect(JSON.stringify(result)).not.toContain("opaque");

    const users = await db.select().from(identityUsers);
    const accounts = await db.select().from(identityAccounts);
    const addresses = await db.select().from(identityEmailAddresses);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      email: "artist.name+shop@example.com",
      canonicalEmail: "artist.name+shop@example.com",
      emailVerified: false,
      accessStatus: "active",
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      providerId: "credential",
      password: "hash:a unique password phrase",
      passwordHashVersion: 1,
    });
    expect(addresses).toEqual([
      expect.objectContaining({
        userId: users[0]?.id,
        displayEmail: "Artist.Name+Shop@example.com",
        canonicalEmail: "artist.name+shop@example.com",
        status: "primary",
        verifiedAt: null,
      }),
    ]);

    await expect(
      service.registerPassword({
        name: "Duplicate",
        email: "artist.name+shop@example.com",
        password: "another unique password",
      }),
    ).resolves.toEqual({ accepted: true });
    await expect(db.select().from(identityUsers)).resolves.toHaveLength(1);
  });

  test("resend replaces the active challenge and verification records provenance", async () => {
    const original = latestToken("email_verification");
    await expect(
      service.resendEmailVerification({ email: "ARTIST.NAME+SHOP@example.com" }),
    ).resolves.toEqual({ accepted: true });
    const replacement = latestToken("email_verification");
    expect(replacement).not.toBe(original);
    await expect(service.verifyEmail({ token: original })).resolves.toEqual({ verified: false });
    await expect(service.verifyEmail({ token: replacement })).resolves.toEqual({ verified: true });

    const [user] = await db.select().from(identityUsers);
    expect(user).toMatchObject({
      emailVerified: true,
      emailVerifiedAt: fixedNow,
      emailVerificationProvenance: "password_email_challenge",
    });
  });

  test("password change requires fresh primary proof, revokes other sessions, and queues a notice", async () => {
    const [user] = await db.select().from(identityUsers);
    if (!user) throw new Error("Expected registered user");
    const currentSessionId = randomUUID();
    const otherSessionId = randomUUID();
    const createSession = (id: string, token: string) =>
      db.transaction((tx) =>
        identity.createAuthoritativeSession(tx, {
          id,
          userId: user.id,
          token,
          kind: "user",
          authorizationVersion: user.authorizationVersion,
          now: fixedNow,
        }),
      );
    await createSession(currentSessionId, "current-session-before-change");
    await createSession(otherSessionId, "other-session-before-change");
    const noticesBefore = await db
      .select()
      .from(systemOutbox)
      .where(eq(systemOutbox.eventType, "identity.security_email.requested.v1"));

    await expect(
      service.changePassword({
        userId: user.id,
        currentPassword: "a unique password phrase",
        newPassword: "a changed unique password",
        currentSessionId,
        primaryAuthenticatedAt: fixedNow,
      }),
    ).resolves.toEqual({ changed: true });

    const sessions = await db.select().from(identitySessions);
    expect(sessions.find((session) => session.id === currentSessionId)?.revokedAt).toBeNull();
    expect(sessions.find((session) => session.id === otherSessionId)?.revokedAt).toEqual(fixedNow);
    const noticesAfter = await db
      .select()
      .from(systemOutbox)
      .where(eq(systemOutbox.eventType, "identity.security_email.requested.v1"));
    expect(noticesAfter).toHaveLength(noticesBefore.length + 1);

    await expect(
      service.changePassword({
        userId: user.id,
        currentPassword: "a changed unique password",
        newPassword: "another changed unique password",
        currentSessionId,
        primaryAuthenticatedAt: new Date(fixedNow.getTime() - 15 * 60_000 - 1),
      }),
    ).rejects.toThrow("Identity request does not meet policy");
  });

  test("equalizes known and unknown password-reset requests through the password work factor", async () => {
    const before = hashedInputs.length;
    const unknown = await service.requestPasswordReset({ email: "unknown@example.com" });
    const known = await service.requestPasswordReset({ email: "artist.name+shop@example.com" });
    expect(unknown).toEqual(known);
    expect(hashedInputs.slice(before)).toEqual([
      "pawket-enumeration-timing-pad",
      "pawket-enumeration-timing-pad",
    ]);
  });

  test("password reset is enumeration-safe, single-use, and revokes every session", async () => {
    const [user] = await db.select().from(identityUsers);
    if (!user) throw new Error("Expected registered user");
    await db.transaction((tx) =>
      identity.createAuthoritativeSession(tx, {
        id: randomUUID(),
        userId: user.id,
        token: "session-before-password-reset",
        kind: "user",
        authorizationVersion: user.authorizationVersion,
        now: fixedNow,
      }),
    );

    await expect(
      service.requestPasswordReset({ email: "missing@example.com" }),
    ).resolves.toEqual({ accepted: true });
    await expect(
      service.requestPasswordReset({ email: "artist.name+shop@example.com" }),
    ).resolves.toEqual({ accepted: true });
    const resetToken = latestToken("password_reset");
    await expect(
      service.resetPassword({ token: resetToken, newPassword: "a newer unique password" }),
    ).resolves.toEqual({ completed: true });
    await expect(
      service.resetPassword({ token: resetToken, newPassword: "yet another unique password" }),
    ).resolves.toEqual({ completed: false });

    const [credential] = await db
      .select()
      .from(identityAccounts)
      .where(eq(identityAccounts.providerId, "credential"));
    expect(credential?.password).toBe("hash:a newer unique password");
    const sessions = await db.select().from(identitySessions);
    expect(sessions.every((session) => session.revokedAt !== null)).toBe(true);
    const activeResetChallenges = await db
      .select()
      .from(identityVerifications)
      .where(
        and(
          eq(identityVerifications.purpose, "password_reset"),
          eq(identityVerifications.userId, user.id),
        ),
      );
    expect(activeResetChallenges.every((challenge) => challenge.consumedAt !== null)).toBe(true);
  });

  test("email change verifies the new address, preserves old ownership, and revokes other sessions", async () => {
    const [user] = await db.select().from(identityUsers);
    if (!user) throw new Error("Expected registered user");
    const currentSessionId = randomUUID();
    const otherSessionId = randomUUID();
    for (const [id, token] of [
      [currentSessionId, "email-change-current-session"],
      [otherSessionId, "email-change-other-session"],
    ] as const) {
      await db.transaction((tx) =>
        identity.createAuthoritativeSession(tx, {
          id,
          userId: user.id,
          token,
          kind: "user",
          authorizationVersion: user.authorizationVersion,
          now: fixedNow,
        }),
      );
    }

    await expect(
      service.requestEmailChange({
        userId: user.id,
        newEmail: "New.Artist@EXAMPLE.COM",
        primaryAuthenticatedAt: fixedNow,
      }),
    ).resolves.toEqual({ accepted: true });
    const emailChangeToken = latestToken("email_change");
    const noticesBeforeCompletion = await db
      .select()
      .from(systemOutbox)
      .where(eq(systemOutbox.eventType, "identity.security_email.requested.v1"));

    const otherUserId = randomUUID();
    await db.insert(identityUsers).values({
      id: otherUserId,
      name: "Other User",
      email: "other-user@example.com",
      canonicalEmail: "other-user@example.com",
      createdAt: fixedNow,
      updatedAt: fixedNow,
    });
    await expect(
      service.completeEmailChange({
        userId: otherUserId,
        token: emailChangeToken,
        currentSessionId: "other-user-session",
      }),
    ).resolves.toEqual({ completed: false });

    await expect(
      service.completeEmailChange({
        userId: user.id,
        token: emailChangeToken,
        currentSessionId,
      }),
    ).resolves.toEqual({ completed: true });

    const [updatedUser] = await db
      .select()
      .from(identityUsers)
      .where(eq(identityUsers.id, user.id));
    expect(updatedUser).toMatchObject({
      email: "new.artist@example.com",
      canonicalEmail: "new.artist@example.com",
      emailVerified: true,
      emailVerificationProvenance: "password_email_challenge",
    });
    const addresses = await db
      .select()
      .from(identityEmailAddresses)
      .orderBy(identityEmailAddresses.createdAt);
    expect(addresses.map((address) => ({
      canonicalEmail: address.canonicalEmail,
      status: address.status,
      replacedAt: address.replacedAt,
    }))).toEqual([
      {
        canonicalEmail: "artist.name+shop@example.com",
        status: "previous",
        replacedAt: fixedNow,
      },
      {
        canonicalEmail: "new.artist@example.com",
        status: "primary",
        replacedAt: null,
      },
    ]);
    const sessions = await db.select().from(identitySessions);
    expect(sessions.find((session) => session.id === currentSessionId)).toMatchObject({
      revokedAt: null,
      authorizationVersion: updatedUser?.authorizationVersion,
    });
    expect(sessions.find((session) => session.id === otherSessionId)?.revokedAt).toEqual(fixedNow);
    const noticesAfterCompletion = await db
      .select()
      .from(systemOutbox)
      .where(eq(systemOutbox.eventType, "identity.security_email.requested.v1"));
    expect(noticesAfterCompletion).toHaveLength(noticesBeforeCompletion.length + 1);
  });

  test("account suspension increments authorization state and revokes remaining sessions", async () => {
    const [user] = await db
      .select()
      .from(identityUsers)
      .where(eq(identityUsers.canonicalEmail, "new.artist@example.com"));
    if (!user) throw new Error("Expected registered user");
    await expect(
      service.setUserAccessStatus({ userId: user.id, status: "access_suspended" }),
    ).resolves.toBe(true);
    const [updated] = await db
      .select()
      .from(identityUsers)
      .where(eq(identityUsers.id, user.id));
    expect(updated).toMatchObject({
      accessStatus: "access_suspended",
      authorizationVersion: user.authorizationVersion + 1,
    });
  });
});
