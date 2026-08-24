import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  identityAccounts,
  identitySessions,
  identityUsers,
  type PawketDatabase,
} from "@pawket/database";
import * as schema from "@pawket/database";
import { createEncryptionKeyring } from "@pawket/security";
import * as identity from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for identity integration tests");

type PawketAuth = {
  handler(request: Request): Promise<Response>;
  api: { getSession(input: { headers: Headers }): Promise<unknown> };
};
type AuthFactory = {
  createPawketAuth(options: {
    db: PawketDatabase;
    baseURL: string;
    trustedOrigins: readonly string[];
    secret: string;
    lookupHmacKey: Uint8Array;
    throttle?: { maximumAttempts: number; windowMs: number; blockMs: number };
  }): PawketAuth;
  hashPassword(password: string): Promise<string>;
  hashSessionToken(token: string): string;
  createIdentityService(options: {
    db: PawketDatabase;
    keyring: ReturnType<typeof createEncryptionKeyring>;
    lookupHmacKey: Uint8Array;
    compromisedPasswordChecker: { isCompromised(password: string): Promise<boolean> };
    tokenFactory(purpose: string): string;
  }): {
    registerPassword(input: { name: string; email: string; password: string }): Promise<unknown>;
    verifyEmail(input: { token: string }): Promise<{ verified: boolean }>;
  };
};

const authExports = identity as unknown as Partial<AuthFactory>;
const schemaName = `better_auth_boundary_${process.pid}_${Date.now()}`;
const client = postgres(databaseUrl, { max: 1 });
const db = drizzle(client, { schema }) as PawketDatabase;
const migrationsDirectory = new URL("../../database/migrations/", import.meta.url);
const baseURL = "https://pawket.example";
let auth: PawketAuth;
let service: ReturnType<NonNullable<AuthFactory["createIdentityService"]>>;
let serviceVerificationToken = "";
let boundaryCookie = "";

async function executeMigration(filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.unsafe(statement);
  }
}

async function post(path: string, body: unknown, origin = baseURL): Promise<Response> {
  return auth.handler(
    new Request(`${baseURL}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "user-agent": "Mozilla/5.0 Chrome/140.0.0.0",
        "x-forwarded-for": "203.0.113.42",
      },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  expect(typeof authExports.createPawketAuth).toBe("function");
  await client.unsafe(`create schema "${schemaName}"`);
  await client.unsafe(`set search_path to "${schemaName}", public`);
  const migrations = (await readdir(migrationsDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  for (const migration of migrations) await executeMigration(migration);

  const password = "boundary password long enough";
  await db.insert(identityUsers).values({
    id: "boundary-user",
    name: "Boundary Artist",
    email: "boundary@example.com",
    canonicalEmail: "boundary@example.com",
    emailVerified: true,
    emailVerifiedAt: new Date("2026-08-24T00:00:00.000Z"),
    emailVerificationProvenance: "password_email_challenge",
    accessStatus: "active",
    authorizationVersion: 3,
  });
  await db.insert(identityAccounts).values({
    id: randomUUID(),
    issuer: "local:credential",
    accountId: "boundary-user",
    providerId: "credential",
    userId: "boundary-user",
    password: await authExports.hashPassword!(password),
    passwordHashVersion: 1,
  });
  auth = authExports.createPawketAuth!({
    db,
    baseURL,
    trustedOrigins: [baseURL],
    secret: "production-like-auth-secret-at-least-32-characters",
    lookupHmacKey: Uint8Array.from({ length: 32 }, (_, index) => index + 20),
    throttle: { maximumAttempts: 20, windowMs: 60_000, blockMs: 120_000 },
  });
  service = authExports.createIdentityService!({
    db,
    keyring: createEncryptionKeyring({
      activeKeyId: "test-v1",
      keys: { "test-v1": Uint8Array.from({ length: 32 }, (_, index) => index + 1) },
    }),
    lookupHmacKey: Uint8Array.from({ length: 32 }, (_, index) => index + 20),
    compromisedPasswordChecker: { async isCompromised() { return false; } },
    tokenFactory(purpose) {
      const token = `${purpose}-${randomUUID()}`;
      if (purpose === "email_verification") serviceVerificationToken = token;
      return token;
    },
  });
});

afterAll(async () => {
  await client.unsafe("set search_path to public");
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.end();
});

describe("Pawket Better Auth boundary", () => {
  test("disables every policy-owned endpoint that could bypass Pawket services", async () => {
    for (const [path, body] of [
      ["/sign-up/email", { email: "new@example.com", name: "New", password: "long enough password" }],
      ["/request-password-reset", { email: "boundary@example.com" }],
      ["/change-password", { currentPassword: "x", newPassword: "y" }],
      ["/change-email", { newEmail: "other@example.com" }],
      ["/set-password", { newPassword: "bypass password long enough" }],
      ["/list-sessions", {}],
      ["/revoke-session", { token: "unsafe-raw-token" }],
      ["/sign-in/social", { provider: "google" }],
      ["/link-social", { provider: "google" }],
    ] as const) {
      const response = await post(path, body);
      expect(response.status, path).toBe(404);
    }
  });

  test("signs in through a secure host-only cookie while storing only authoritative metadata", async () => {
    const response = await post("/sign-in/email", {
      email: "BOUNDARY@EXAMPLE.COM",
      password: "boundary password long enough",
      callbackURL: "/settings/security",
    });
    const payload = (await response.json()) as Record<string, unknown>;
    const setCookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(payload).not.toHaveProperty("token");
    expect(setCookie).toContain("__Host-pawket.session=");
    expect(setCookie).toMatch(/HttpOnly/iu);
    expect(setCookie).toMatch(/Secure/iu);
    expect(setCookie).toMatch(/SameSite=Lax/iu);
    expect(setCookie).toMatch(/Path=\//u);
    expect(setCookie).not.toMatch(/Domain=/iu);

    const [session] = await db.select().from(identitySessions);
    expect(session?.token).toMatch(/^sha256:/u);
    expect(JSON.stringify(session)).not.toContain(setCookie.split("=")[1]?.split(";")[0]);
    expect(session).toMatchObject({
      assuranceState: "active",
      authorizationVersion: 3,
      userAgent: "Chrome",
    });
    expect(session?.ipAddress).toMatch(/^hmac-sha256:v1:/u);
    expect(session?.ipAddress).not.toContain("203.0.113.42");
    expect(session?.absoluteExpiresAt.getTime()).toBeGreaterThan(session!.idleExpiresAt.getTime());

    const cookie = setCookie.split(";")[0] ?? "";
    boundaryCookie = cookie;
    const resolved = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(resolved).toEqual(
      expect.objectContaining({ user: expect.objectContaining({ id: "boundary-user" }) }),
    );
  });

  test("uses a host-only non-secure cookie only for an explicit HTTP local origin", async () => {
    const localBaseURL = "http://localhost:3000";
    const localAuth = authExports.createPawketAuth!({
      db,
      baseURL: localBaseURL,
      trustedOrigins: [localBaseURL],
      secret: "local-auth-secret-at-least-32-characters",
      lookupHmacKey: Buffer.alloc(32, 5),
      throttle: { maximumAttempts: 20, windowMs: 60_000, blockMs: 120_000 },
    });
    const response = await localAuth.handler(
      new Request(`${localBaseURL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: localBaseURL },
        body: JSON.stringify({
          email: "boundary@example.com",
          password: "boundary password long enough",
        }),
      }),
    );
    const setCookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(setCookie).toContain("pawket.session=");
    expect(setCookie).not.toContain("__Host-");
    expect(setCookie).not.toMatch(/;\s*Secure/iu);
    expect(setCookie).not.toMatch(/Domain=/iu);
  });

  test("refreshes the seven-day idle bound without crossing the absolute lifetime", async () => {
    const [before] = await db
      .select()
      .from(identitySessions)
      .where(eq(identitySessions.userId, "boundary-user"));
    if (!before) throw new Error("Expected boundary session");
    const staleUpdate = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    const shortIdle = new Date(Date.now() + 60_000);
    await db
      .update(identitySessions)
      .set({
        updatedAt: staleUpdate,
        expiresAt: shortIdle,
        idleExpiresAt: shortIdle,
      })
      .where(eq(identitySessions.id, before.id));

    await expect(
      auth.api.getSession({ headers: new Headers({ cookie: boundaryCookie }) }),
    ).resolves.toEqual(expect.objectContaining({ user: expect.objectContaining({ id: "boundary-user" }) }));
    const [after] = await db
      .select()
      .from(identitySessions)
      .where(eq(identitySessions.id, before.id));
    expect(after?.idleExpiresAt.getTime()).toBeGreaterThan(shortIdle.getTime());
    expect(after?.expiresAt).toEqual(after?.idleExpiresAt);
    expect(after!.idleExpiresAt.getTime()).toBeLessThanOrEqual(after!.absoluteExpiresAt.getTime());
  });

  test("ignores attacker-supplied session material and always issues a fresh session", async () => {
    const attackerToken = "attacker-fixed-session-token";
    const response = await auth.handler(
      new Request(`${baseURL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `__Host-pawket.session=${attackerToken}`,
          origin: baseURL,
        },
        body: JSON.stringify({
          email: "boundary@example.com",
          password: "boundary password long enough",
          token: attackerToken,
        }),
      }),
    );

    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("__Host-pawket.session=");
    expect(setCookie).not.toContain(attackerToken);
    const sessions = await db
      .select({ token: identitySessions.token })
      .from(identitySessions)
      .where(eq(identitySessions.userId, "boundary-user"));
    expect(sessions).not.toContainEqual({ token: authExports.hashSessionToken!(attackerToken) });
  });

  test("logs out by invalidating the authoritative session immediately", async () => {
    const signIn = await post("/sign-in/email", {
      email: "boundary@example.com",
      password: "boundary password long enough",
    });
    const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toContain("__Host-pawket.session=");

    const signOut = await auth.handler(
      new Request(`${baseURL}/api/auth/sign-out`, {
        method: "POST",
        headers: { cookie, origin: baseURL },
      }),
    );

    expect(signOut.status).toBe(200);
    await expect(auth.api.getSession({ headers: new Headers({ cookie }) })).resolves.toBeNull();
  });

  test("rejects untrusted origins and non-local callback paths before authentication", async () => {
    const foreignOrigin = await post(
      "/sign-in/email",
      { email: "boundary@example.com", password: "boundary password long enough" },
      "https://evil.example",
    );
    expect(foreignOrigin.status).toBe(403);

    for (const callbackURL of ["//evil.example/path", "https://evil.example/path"] as const) {
      const response = await post("/sign-in/email", {
        email: "boundary@example.com",
        password: "boundary password long enough",
        callbackURL,
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  test("uses the same public failure for an unknown account and a wrong password", async () => {
    const wrong = await post("/sign-in/email", {
      email: "boundary@example.com",
      password: "wrong password long enough",
    });
    const missing = await post("/sign-in/email", {
      email: "missing@example.com",
      password: "wrong password long enough",
    });
    expect(missing.status).toBe(wrong.status);
    expect(await missing.json()).toEqual(await wrong.json());
  });

  test("signs in an account created and verified through Pawket's canonical registration service", async () => {
    await service.registerPassword({
      name: "Mixed Case Artist",
      email: "Mixed.Case@EXAMPLE.COM",
      password: "service boundary password long enough",
    });
    await expect(service.verifyEmail({ token: serviceVerificationToken })).resolves.toEqual({
      verified: true,
    });

    const response = await post("/sign-in/email", {
      email: "MIXED.CASE@example.com",
      password: "service boundary password long enough",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("__Host-pawket.session=");
  });
});
