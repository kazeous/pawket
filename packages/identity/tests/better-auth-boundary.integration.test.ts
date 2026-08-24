import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import {
  identityAccounts,
  identityEmailAddresses,
  identityEmailHandoffs,
  identityExternalLinkTransactions,
  identityRecoveryCodes,
  identityRoleGrants,
  identitySessions,
  identityTotpAuthenticators,
  identityUsers,
  type PawketDatabase,
} from "@pawket/database";
import * as schema from "@pawket/database";
import {
  createEncryptionKeyring,
  decryptSensitiveField,
  type EncryptionEnvelope,
} from "@pawket/security";
import * as identity from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for identity integration tests");

type PawketAuth = {
  handler(request: Request): Promise<Response>;
  api: { getSession(input: { headers: Headers }): Promise<unknown> };
  enabledProviders: readonly ("google" | "discord")[];
};
type AuthFactory = {
  createPawketAuth(options: {
    db: PawketDatabase;
    baseURL: string;
    trustedOrigins: readonly string[];
    secret: string;
    keyring: ReturnType<typeof createEncryptionKeyring>;
    socialProviders?: {
      google?: { clientId: string; clientSecret: string };
      discord?: { clientId: string; clientSecret: string };
    };
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
let totpEnrollmentCookie = "";
let recoveryCodes: string[] = [];
let totpVerifiedCookie = "";
let totpSecret = "";
let initialTotpAuthenticatorId = "";
let initialTotpEnvelope: EncryptionEnvelope<"identity_totp_authenticator", "secret"> | null = null;
const authKeyring = createEncryptionKeyring({
  activeKeyId: "auth-test-v1",
  keys: { "auth-test-v1": Uint8Array.from({ length: 32 }, (_, index) => index + 31) },
});

function createSocialAuth(): PawketAuth {
  return authExports.createPawketAuth!({
    db,
    baseURL,
    trustedOrigins: [baseURL],
    secret: "production-like-auth-secret-at-least-32-characters",
    keyring: authKeyring,
    lookupHmacKey: Uint8Array.from({ length: 32 }, (_, index) => index + 20),
    socialProviders: {
      google: { clientId: "google-client-id", clientSecret: "google-client-secret" },
      discord: { clientId: "discord-client-id", clientSecret: "discord-client-secret" },
    },
  });
}

function mockDiscordProvider(input: { id: string; email: string | null; verified?: boolean }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
    const url =
      typeof request === "string"
        ? request
        : request instanceof URL
          ? request.href
          : request.url;
    if (url === "https://discord.com/api/oauth2/token") {
      return Response.json({
        access_token: "sign-in-only-access-token",
        refresh_token: "sign-in-only-refresh-token",
        token_type: "Bearer",
        expires_in: 3_600,
        scope: "identify email",
      });
    }
    if (url === "https://discord.com/api/users/%40me") {
      return Response.json({
        id: input.id,
        username: "pawket-artist",
        global_name: "Pawket Artist",
        discriminator: "0",
        avatar: null,
        email: input.email,
        verified: input.verified ?? true,
      });
    }
    throw new Error(`Unexpected OAuth request: ${url}`);
  });
}

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

async function postWithCookie(path: string, body: unknown, cookie: string): Promise<Response> {
  return auth.handler(
    new Request(`${baseURL}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: baseURL,
      },
      body: JSON.stringify(body),
    }),
  );
}

function responseCookieContaining(response: Response, fragment: string): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0] ?? "")
    .find((value) => value.includes(fragment)) ?? "";
}

async function installNoticeFailure(event: string): Promise<void> {
  if (!/^[a-z_]+$/u.test(event)) throw new Error("Invalid test notice event");
  await client.unsafe(`
    create or replace function fail_identity_notice_for_test()
    returns trigger as $$
    begin
      if new.template_data ->> 'event' = '${event}' then
        raise exception 'forced security notice failure';
      end if;
      return new;
    end;
    $$ language plpgsql
  `);
  await client.unsafe(`
    create trigger fail_identity_notice_for_test
    before insert on identity_email_handoffs
    for each row execute function fail_identity_notice_for_test()
  `);
}

async function removeNoticeFailure(): Promise<void> {
  await client.unsafe(
    "drop trigger if exists fail_identity_notice_for_test on identity_email_handoffs",
  );
  await client.unsafe("drop function if exists fail_identity_notice_for_test()");
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
  await db.insert(identityUsers).values({
    id: "totp-failure-user",
    name: "TOTP Failure Artist",
    email: "totp-failure@example.com",
    canonicalEmail: "totp-failure@example.com",
    emailVerified: true,
    emailVerifiedAt: new Date("2026-08-24T00:00:00.000Z"),
    emailVerificationProvenance: "password_email_challenge",
    accessStatus: "active",
    authorizationVersion: 1,
  });
  await db.insert(identityAccounts).values({
    id: randomUUID(),
    issuer: "local:credential",
    accountId: "totp-failure-user",
    providerId: "credential",
    userId: "totp-failure-user",
    password: await authExports.hashPassword!("totp failure password long enough"),
    passwordHashVersion: 1,
  });
  await db.insert(identityUsers).values({
    id: "totp-boundary-user",
    name: "TOTP Boundary Artist",
    email: "totp-boundary@example.com",
    canonicalEmail: "totp-boundary@example.com",
    emailVerified: true,
    emailVerifiedAt: new Date("2026-08-24T00:00:00.000Z"),
    emailVerificationProvenance: "password_email_challenge",
    accessStatus: "active",
    authorizationVersion: 1,
  });
  await db.insert(identityAccounts).values({
    id: randomUUID(),
    issuer: "local:credential",
    accountId: "totp-boundary-user",
    providerId: "credential",
    userId: "totp-boundary-user",
    password: await authExports.hashPassword!("totp boundary password long enough"),
    passwordHashVersion: 1,
  });
  auth = authExports.createPawketAuth!({
    db,
    baseURL,
    trustedOrigins: [baseURL],
    secret: "production-like-auth-secret-at-least-32-characters",
    keyring: authKeyring,
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

  test("rolls back TOTP enrollment when recovery-code notice persistence fails", async () => {
    const signedIn = await post("/sign-in/email", {
      email: "totp-failure@example.com",
      password: "totp failure password long enough",
    });
    const enrollmentCookie = responseCookieContaining(signedIn, "pawket.session=");
    const enabled = await postWithCookie(
      "/two-factor/enable",
      { method: "totp", password: "totp failure password long enough" },
      enrollmentCookie,
    );
    const payload = (await enabled.json()) as { totpURI: string };
    const encodedSecret = new URL(payload.totpURI).searchParams.get("secret");
    if (!encodedSecret) throw new Error("Expected failure-fixture TOTP secret");
    const secret = Buffer.from(base32.decode(encodedSecret)).toString("utf8");
    const code = await createOTP(secret, { digits: 6, period: 30 }).totp();

    await installNoticeFailure("totp_enrolled");
    let verification: Response | undefined;
    try {
      verification = await postWithCookie(
        "/two-factor/verify-totp",
        { code, trustDevice: false },
        enrollmentCookie,
      );
    } finally {
      await removeNoticeFailure();
    }
    if (!verification) throw new Error("Expected failed TOTP verification response");
    expect(verification.status).toBe(503);

    const [user] = await db
      .select()
      .from(identityUsers)
      .where(eq(identityUsers.id, "totp-failure-user"));
    expect(user?.twoFactorEnabled).toBe(false);
    await expect(
      db
        .select()
        .from(identityTotpAuthenticators)
        .where(eq(identityTotpAuthenticators.userId, "totp-failure-user")),
    ).resolves.toHaveLength(0);
    const sessions = await db
      .select()
      .from(identitySessions)
      .where(eq(identitySessions.userId, "totp-failure-user"));
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((session) => session.revokedAt instanceof Date)).toBe(true);

    const retry = await post("/sign-in/email", {
      email: "totp-failure@example.com",
      password: "totp failure password long enough",
    });
    expect(retry.status).toBe(200);
    await postWithCookie(
      "/sign-out",
      {},
      responseCookieContaining(retry, "pawket.session="),
    );
  });

  test("enrolls TOTP with an application-encrypted seed and no library recovery codes", async () => {
    const signedIn = await post("/sign-in/email", {
      email: "totp-boundary@example.com",
      password: "totp boundary password long enough",
    });
    const enrollmentCookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(enrollmentCookie).toContain("__Host-pawket.session=");
    const enabled = await postWithCookie(
      "/two-factor/enable",
      { method: "totp", password: "totp boundary password long enough" },
      enrollmentCookie,
    );
    const payload = (await enabled.json()) as {
      totpURI?: string;
      backupCodes?: string[];
    };

    expect(enabled.status).toBe(200);
    expect(payload.backupCodes).toEqual([]);
    expect(payload.totpURI).toMatch(/^otpauth:\/\/totp\/Pawket:/u);

    const [stored] = await db
      .select()
      .from(identityTotpAuthenticators)
      .where(eq(identityTotpAuthenticators.userId, "totp-boundary-user"));
    expect(stored?.secret).toEqual(
      expect.objectContaining({ version: 1, algorithm: "A256GCM", keyId: "auth-test-v1" }),
    );
    expect(typeof stored?.secret).not.toBe("string");
    expect(stored?.backupCodes).toBe("[]");
    expect(stored?.verified).toBe(false);
    if (!stored) throw new Error("Expected encrypted TOTP authenticator");
    initialTotpAuthenticatorId = stored.id;
    initialTotpEnvelope = stored.secret as EncryptionEnvelope<
      "identity_totp_authenticator",
      "secret"
    >;

    const uri = new URL(payload.totpURI!);
    const encodedSecret = uri.searchParams.get("secret");
    if (!encodedSecret) throw new Error("Expected TOTP secret in enrollment URI");
    totpSecret = Buffer.from(base32.decode(encodedSecret)).toString("utf8");
    const code = await createOTP(totpSecret, { digits: 6, period: 30 }).totp();
    const verified = await postWithCookie(
      "/two-factor/verify-totp",
      { code, trustDevice: false },
      enrollmentCookie,
    );

    expect(verified.status).toBe(200);
    const verifiedPayload = (await verified.clone().json()) as { recoveryCodes?: string[] };
    expect(verifiedPayload.recoveryCodes).toHaveLength(10);
    recoveryCodes = verifiedPayload.recoveryCodes ?? [];
    totpEnrollmentCookie = responseCookieContaining(verified, "pawket.session=");
    expect(totpEnrollmentCookie).toContain("__Host-pawket.session=");
    const [confirmed] = await db
      .select()
      .from(identityTotpAuthenticators)
      .where(eq(identityTotpAuthenticators.userId, "totp-boundary-user"));
    expect(confirmed?.verified).toBe(true);
    const storedCodes = await db
      .select()
      .from(identityRecoveryCodes);
    expect(storedCodes).toHaveLength(10);
    expect(JSON.stringify(storedCodes)).not.toContain(recoveryCodes[0]);
    const enrollmentNotices = await db.select().from(identityEmailHandoffs);
    expect(
      enrollmentNotices.some((notice) => notice.templateData.event === "totp_enrolled"),
    ).toBe(true);
  });

  test("configures only complete social providers with exact redirects, minimal scopes, and PKCE state", async () => {
    const socialAuth = createSocialAuth();
    expect(socialAuth.enabledProviders).toEqual(["google", "discord"]);

    for (const provider of ["google", "discord"] as const) {
      const response = await socialAuth.handler(
        new Request(`${baseURL}/api/auth/sign-in/social`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: baseURL },
          body: JSON.stringify({ provider, callbackURL: "/settings/security" }),
        }),
      );
      const payload = (await response.json()) as { url?: string };
      expect(response.status).toBe(200);
      const authorization = new URL(payload.url!);
      expect(authorization.searchParams.get("redirect_uri")).toBe(
        `${baseURL}/api/auth/callback/${provider}`,
      );
      expect(authorization.searchParams.get("state")).toBeTruthy();
      expect(authorization.searchParams.get("code_challenge"), provider).toBeTruthy();
      const scopes = new Set((authorization.searchParams.get("scope") ?? "").split(" "));
      expect(scopes).toEqual(
        provider === "google"
          ? new Set(["openid", "email", "profile"])
          : new Set(["identify", "email"]),
      );
      if (provider === "google") expect(authorization.searchParams.get("nonce")).toBeTruthy();
    }

    const link = await socialAuth.handler(
      new Request(`${baseURL}/api/auth/link-social`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: boundaryCookie,
          origin: baseURL,
        },
        body: JSON.stringify({ provider: "discord", callbackURL: "/settings/security" }),
      }),
    );
    expect(link.status).toBe(200);
    const linkPayload = (await link.json()) as { url: string };
    const state = new URL(linkPayload.url).searchParams.get("state");
    expect(state).toBeTruthy();
    const stateCookie = responseCookieContaining(link, "state=");
    expect(stateCookie).toBeTruthy();
    const transactions = await db.select().from(identityExternalLinkTransactions);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      userId: "boundary-user",
      provider: "discord",
      returnPath: "/settings/security",
      status: "pending",
    });

    const mixUp = await socialAuth.handler(
      new Request(`${baseURL}/api/auth/callback/google?code=wrong-provider&state=${state}`, {
        headers: { cookie: `${boundaryCookie}; ${stateCookie}` },
      }),
    );
    expect(mixUp.status).toBe(400);

    const fetchSpy = mockDiscordProvider({
      id: "123456789012345678",
      email: "boundary@example.com",
    });
    let callbacks: Response[] = [];
    try {
      callbacks = await Promise.all(
        ["valid-code-a", "valid-code-b"].map((code) =>
          socialAuth.handler(
            new Request(`${baseURL}/api/auth/callback/discord?code=${code}&state=${state}`, {
              headers: { cookie: `${boundaryCookie}; ${stateCookie}` },
            }),
          ),
        ),
      );
    } finally {
      fetchSpy.mockRestore();
    }
    expect(callbacks.map((response) => response.status).sort()).toEqual([302, 400]);
    const callback = callbacks.find((response) => response.status === 302);
    if (!callback) throw new Error("Expected one claimed social callback");
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/settings/security");
    const [linkedAccount] = await db
      .select()
      .from(identityAccounts)
      .where(eq(identityAccounts.accountId, "123456789012345678"));
    expect(linkedAccount).toMatchObject({
      userId: "boundary-user",
      providerId: "discord",
      issuer: "https://discord.com",
      accessToken: null,
      refreshToken: null,
      idToken: null,
      scope: null,
    });
    const [completed] = await db.select().from(identityExternalLinkTransactions);
    expect(completed).toMatchObject({ status: "completed", resultCode: "linked" });

    const replay = await socialAuth.handler(
      new Request(`${baseURL}/api/auth/callback/discord?code=replay&state=${state}`, {
        headers: { cookie: `${boundaryCookie}; ${stateCookie}` },
      }),
    );
    expect(replay.status).toBe(400);

    const unlink = await socialAuth.handler(
      new Request(`${baseURL}/api/auth/unlink-account`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: boundaryCookie, origin: baseURL },
        body: JSON.stringify({ accountId: linkedAccount!.id }),
      }),
    );
    expect(unlink.status).toBe(200);
    const [credential] = await db
      .select({ id: identityAccounts.id })
      .from(identityAccounts)
      .where(eq(identityAccounts.userId, "boundary-user"));
    const lastMethod = await socialAuth.handler(
      new Request(`${baseURL}/api/auth/unlink-account`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: boundaryCookie, origin: baseURL },
        body: JSON.stringify({ accountId: credential!.id }),
      }),
    );
    expect(lastMethod.status).toBe(400);
    const identityNotices = await db.select().from(identityEmailHandoffs);
    expect(
      identityNotices.some((notice) => notice.templateData.event === "social_identity_linked"),
    ).toBe(true);
    expect(
      identityNotices.some((notice) => notice.templateData.event === "social_identity_unlinked"),
    ).toBe(true);
  });

  test("rolls back social link and unlink when their security notice cannot commit", async () => {
    const socialAuth = createSocialAuth();
    const link = await socialAuth.handler(
      new Request(`${baseURL}/api/auth/link-social`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: boundaryCookie,
          origin: baseURL,
        },
        body: JSON.stringify({ provider: "discord", callbackURL: "/settings/security" }),
      }),
    );
    const linkPayload = (await link.json()) as { url: string };
    const state = new URL(linkPayload.url).searchParams.get("state");
    const fetchSpy = mockDiscordProvider({
      id: "923456789012345678",
      email: "boundary@example.com",
    });
    await installNoticeFailure("social_identity_linked");
    let failedLink: Response | undefined;
    try {
      failedLink = await socialAuth.handler(
        new Request(`${baseURL}/api/auth/callback/discord?code=notice-failure&state=${state}`, {
          headers: {
            cookie: `${boundaryCookie}; ${responseCookieContaining(link, "state=")}`,
          },
        }),
      );
    } finally {
      fetchSpy.mockRestore();
      await removeNoticeFailure();
    }
    if (!failedLink) throw new Error("Expected failed social-link response");
    expect(failedLink.status).toBe(503);
    await expect(
      db
        .select()
        .from(identityAccounts)
        .where(eq(identityAccounts.accountId, "923456789012345678")),
    ).resolves.toHaveLength(0);
    const rolledBackLinks = await db
      .select()
      .from(identityExternalLinkTransactions)
      .where(eq(identityExternalLinkTransactions.resultCode, "notice_failed_rolled_back"));
    expect(rolledBackLinks).toHaveLength(1);

    const socialAccountId = randomUUID();
    await db.insert(identityAccounts).values({
      id: socialAccountId,
      issuer: "https://discord.com",
      accountId: "823456789012345678",
      providerId: "discord",
      userId: "boundary-user",
    });
    const [credentialAccount] = await db
      .select({ id: identityAccounts.id })
      .from(identityAccounts)
      .where(eq(identityAccounts.accountId, "boundary-user"));
    const credentialUnlink = await socialAuth.handler(
      new Request(`${baseURL}/api/auth/unlink-account`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: boundaryCookie,
          origin: baseURL,
        },
        body: JSON.stringify({ accountId: credentialAccount?.id }),
      }),
    );
    expect(credentialUnlink.status).toBe(400);
    await installNoticeFailure("social_identity_unlinked");
    let failedUnlink: Response | undefined;
    try {
      failedUnlink = await socialAuth.handler(
        new Request(`${baseURL}/api/auth/unlink-account`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: boundaryCookie,
            origin: baseURL,
          },
          body: JSON.stringify({ accountId: socialAccountId }),
        }),
      );
    } finally {
      await removeNoticeFailure();
    }
    if (!failedUnlink) throw new Error("Expected failed social-unlink response");
    expect(failedUnlink.status).toBe(503);
    await expect(
      db.select().from(identityAccounts).where(eq(identityAccounts.id, socialAccountId)),
    ).resolves.toHaveLength(1);

    const retriedUnlink = await socialAuth.handler(
      new Request(`${baseURL}/api/auth/unlink-account`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: boundaryCookie,
          origin: baseURL,
        },
        body: JSON.stringify({ accountId: socialAccountId }),
      }),
    );
    expect(retriedUnlink.status).toBe(200);
    await expect(
      db.select().from(identityAccounts).where(eq(identityAccounts.id, socialAccountId)),
    ).resolves.toHaveLength(0);
  });

  test("keeps a social primary sign-in MFA-pending until TOTP succeeds", async () => {
    const socialAuth = createSocialAuth();
    await db.insert(identityAccounts).values({
      id: randomUUID(),
      issuer: "https://discord.com",
      accountId: "223456789012345678",
      providerId: "discord",
      userId: "totp-boundary-user",
    });
    const started = await socialAuth.handler(
      new Request(`${baseURL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseURL },
        body: JSON.stringify({ provider: "discord", callbackURL: "/settings/security" }),
      }),
    );
    const state = new URL(((await started.json()) as { url: string }).url).searchParams.get("state");
    const stateCookie = responseCookieContaining(started, "state=");
    expect(stateCookie).toBeTruthy();
    const fetchSpy = mockDiscordProvider({
      id: "223456789012345678",
      email: "totp-boundary@example.com",
    });
    let callback: Response;
    try {
      callback = await socialAuth.handler(
        new Request(`${baseURL}/api/auth/callback/discord?code=valid-code&state=${state}`, {
          headers: { cookie: stateCookie },
        }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(
      "/sign-in/mfa?returnTo=%2Fsettings%2Fsecurity",
    );
    expect(callback.headers.getSetCookie()).toEqual(
      expect.arrayContaining([expect.stringContaining("two_factor=")]),
    );
    const sessionCookies = callback.headers
      .getSetCookie()
      .filter((value) => value.includes("pawket.session="));
    expect(sessionCookies.at(-1)).toContain("Max-Age=0");

    await db
      .update(identityTotpAuthenticators)
      .set({ lastUsedStep: null })
      .where(eq(identityTotpAuthenticators.userId, "totp-boundary-user"));
    const code = await createOTP(totpSecret, { digits: 6, period: 30 }).totp();
    const verified = await socialAuth.handler(
      new Request(`${baseURL}/api/auth/two-factor/verify-totp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: responseCookieContaining(callback, "two_factor="),
          origin: baseURL,
        },
        body: JSON.stringify({ code, trustDevice: false }),
      }),
    );
    expect(verified.status).toBe(200);
    expect(responseCookieContaining(verified, "pawket.session=")).toBeTruthy();
  });

  test("creates only verified unused social emails and refuses collision or missing evidence", async () => {
    const socialAuth = createSocialAuth();
    const scenarios = [
      {
        id: "323456789012345678",
        email: "boundary@example.com",
        verified: true,
        error: "account_not_linked",
      },
      {
        id: "423456789012345678",
        email: "unverified-social@example.com",
        verified: false,
        error: "unable_to_create_user",
      },
      {
        id: "523456789012345678",
        email: null,
        verified: true,
        error: "email_not_found",
      },
    ] as const;

    for (const scenario of scenarios) {
      const started = await socialAuth.handler(
        new Request(`${baseURL}/api/auth/sign-in/social`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: baseURL },
          body: JSON.stringify({ provider: "discord", callbackURL: "/settings/security" }),
        }),
      );
      const state = new URL(((await started.json()) as { url: string }).url).searchParams.get("state");
      const fetchSpy = mockDiscordProvider(scenario);
      let callback: Response;
      try {
        callback = await socialAuth.handler(
          new Request(`${baseURL}/api/auth/callback/discord?code=fixture&state=${state}`, {
            headers: { cookie: responseCookieContaining(started, "state=") },
          }),
        );
      } finally {
        fetchSpy.mockRestore();
      }
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toContain(scenario.error);
      const [account] = await db
        .select({ id: identityAccounts.id })
        .from(identityAccounts)
        .where(eq(identityAccounts.accountId, scenario.id));
      expect(account).toBeUndefined();
    }

    const started = await socialAuth.handler(
      new Request(`${baseURL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseURL },
        body: JSON.stringify({ provider: "discord", callbackURL: "/settings/security" }),
      }),
    );
    const state = new URL(((await started.json()) as { url: string }).url).searchParams.get("state");
    const fetchSpy = mockDiscordProvider({
      id: "623456789012345678",
      email: "new-social@example.com",
      verified: true,
    });
    let callback: Response;
    try {
      callback = await socialAuth.handler(
        new Request(`${baseURL}/api/auth/callback/discord?code=fixture&state=${state}`, {
          headers: { cookie: responseCookieContaining(started, "state=") },
        }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/settings/security");
    const [created] = await db
      .select()
      .from(identityUsers)
      .where(eq(identityUsers.canonicalEmail, "new-social@example.com"));
    expect(created).toMatchObject({
      emailVerified: true,
      emailVerificationProvenance: "provider_assertion",
      accessStatus: "active",
    });
    const [primaryEmail] = await db
      .select()
      .from(identityEmailAddresses)
      .where(eq(identityEmailAddresses.userId, created!.id));
    expect(primaryEmail).toMatchObject({
      canonicalEmail: "new-social@example.com",
      status: "primary",
      verificationProvenance: "provider_assertion",
    });
    const [account] = await db
      .select()
      .from(identityAccounts)
      .where(eq(identityAccounts.accountId, "623456789012345678"));
    expect(account).toMatchObject({
      userId: created!.id,
      accessToken: null,
      refreshToken: null,
      idToken: null,
    });
  });

  test("keeps every primary method MFA-pending and accepts a TOTP time step only once", async () => {
    const signedOut = await postWithCookie("/sign-out", {}, totpEnrollmentCookie);
    expect(signedOut.status).toBe(200);
    await db
      .update(identityTotpAuthenticators)
      .set({ lastUsedStep: null })
      .where(eq(identityTotpAuthenticators.userId, "totp-boundary-user"));

    const [primaryOne, primaryTwo] = await Promise.all([
      post("/sign-in/email", {
        email: "totp-boundary@example.com",
        password: "totp boundary password long enough",
      }),
      post("/sign-in/email", {
        email: "totp-boundary@example.com",
        password: "totp boundary password long enough",
      }),
    ]);
    for (const response of [primaryOne, primaryTwo]) {
      expect(response.status).toBe(200);
      await expect(response.clone().json()).resolves.toEqual(
        expect.objectContaining({ twoFactorRedirect: true, twoFactorMethods: ["totp"] }),
      );
      expect(responseCookieContaining(response, "two_factor=")).not.toBe("");
      expect(
        response.headers
          .getSetCookie()
          .filter((value) => value.includes("pawket.session="))
          .every((value) => value.includes("Max-Age=0")),
      ).toBe(true);
    }

    const code = await createOTP(totpSecret, { digits: 6, period: 30 }).totp();
    const results = await Promise.all(
      [primaryOne, primaryTwo].map((response) =>
        postWithCookie(
          "/two-factor/verify-totp",
          { code, trustDevice: false },
          responseCookieContaining(response, "two_factor="),
        ),
      ),
    );
    expect(results.map((response) => response.status).sort()).toEqual([200, 401]);
    totpVerifiedCookie = responseCookieContaining(
      results.find((response) => response.status === 200)!,
      "pawket.session=",
    );
    expect(totpVerifiedCookie).toContain("__Host-pawket.session=");
  });

  test("uses each Pawket recovery code once, emits a notice, and never grants owner step-up", async () => {
    const oldRecoveryCode = recoveryCodes[0]!;
    const signedOut = await postWithCookie("/sign-out", {}, totpVerifiedCookie);
    expect(signedOut.status).toBe(200);
    const primary = await post("/sign-in/email", {
      email: "totp-boundary@example.com",
      password: "totp boundary password long enough",
    });
    const challengeCookie = responseCookieContaining(primary, "two_factor=");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const invalid = await postWithCookie(
        "/two-factor/verify-recovery-code",
        { code: "INVALID-RECOVERY-CODE" },
        challengeCookie,
      );
      expect(invalid.status).toBe(401);
    }
    const recoveryAttempts = await Promise.all(
      recoveryCodes.slice(0, 2).map((code) =>
        postWithCookie("/two-factor/verify-recovery-code", { code }, challengeCookie),
      ),
    );
    expect(recoveryAttempts.map((response) => response.status).sort()).toEqual([200, 401]);
    const recovered = recoveryAttempts.find((response) => response.status === 200)!;
    expect(recovered.status).toBe(200);
    await expect(recovered.clone().json()).resolves.toEqual(
      expect.objectContaining({ requiresTotpRecovery: true }),
    );
    const recoveredCookie = responseCookieContaining(recovered, "pawket.session=");
    const blockedRegeneration = await postWithCookie(
      "/two-factor/regenerate-recovery-codes",
      {},
      recoveredCookie,
    );
    expect(blockedRegeneration.status).toBe(401);

    const [resetUser] = await db
      .select()
      .from(identityUsers)
      .where(eq(identityUsers.id, "totp-boundary-user"));
    expect(resetUser?.twoFactorEnabled).toBe(false);
    await expect(
      db
        .select()
        .from(identityTotpAuthenticators)
        .where(eq(identityTotpAuthenticators.userId, "totp-boundary-user")),
    ).resolves.toHaveLength(0);
    await expect(db.select().from(identityRecoveryCodes)).resolves.toHaveLength(0);

    const enabled = await postWithCookie(
      "/two-factor/enable",
      { method: "totp", password: "totp boundary password long enough" },
      recoveredCookie,
    );
    expect(enabled.status).toBe(200);
    const enabledPayload = (await enabled.json()) as { totpURI: string };
    const [replacementAuthenticator] = await db
      .select()
      .from(identityTotpAuthenticators)
      .where(eq(identityTotpAuthenticators.userId, "totp-boundary-user"));
    const originalEnvelope = initialTotpEnvelope;
    if (!replacementAuthenticator || !originalEnvelope) {
      throw new Error("Expected replacement and original TOTP authenticators");
    }
    expect(replacementAuthenticator.id).not.toBe(initialTotpAuthenticatorId);
    expect(() =>
      decryptSensitiveField({
        envelope: originalEnvelope,
        binding: {
          recordType: "identity_totp_authenticator",
          recordId: replacementAuthenticator.id,
          fieldName: "secret",
        },
        keyring: authKeyring,
      }),
    ).toThrow();
    const replacementSecret = new URL(enabledPayload.totpURI).searchParams.get("secret");
    if (!replacementSecret) throw new Error("Expected replacement TOTP secret");
    totpSecret = Buffer.from(base32.decode(replacementSecret)).toString("utf8");
    const currentTotp = await createOTP(totpSecret, { digits: 6, period: 30 }).totp();
    const reEnrolled = await postWithCookie(
      "/two-factor/verify-totp",
      { code: currentTotp, trustDevice: false },
      recoveredCookie,
    );
    expect(reEnrolled.status).toBe(200);
    const reEnrolledPayload = (await reEnrolled.clone().json()) as { recoveryCodes?: string[] };
    expect(reEnrolledPayload.recoveryCodes).toHaveLength(10);
    const reEnrolledCookie =
      responseCookieContaining(reEnrolled, "pawket.session=") || recoveredCookie;
    const regenerated = await postWithCookie(
      "/two-factor/regenerate-recovery-codes",
      {},
      reEnrolledCookie,
    );
    expect(regenerated.status).toBe(200);
    const regeneratedPayload = (await regenerated.json()) as { recoveryCodes?: string[] };
    expect(regeneratedPayload.recoveryCodes).toHaveLength(10);
    expect(regeneratedPayload.recoveryCodes).not.toEqual(reEnrolledPayload.recoveryCodes);
    recoveryCodes = regeneratedPayload.recoveryCodes ?? [];

    const replayPrimary = await post("/sign-in/email", {
      email: "totp-boundary@example.com",
      password: "totp boundary password long enough",
    });
    const replay = await postWithCookie(
      "/two-factor/verify-recovery-code",
      { code: oldRecoveryCode },
      responseCookieContaining(replayPrimary, "two_factor="),
    );
    expect(replay.status).toBe(401);

    const notices = await db.select().from(identityEmailHandoffs);
    expect(
      notices.some(
        (notice) => notice.templateData.event === "recovery_code_used_factor_reset_required",
      ),
    ).toBe(true);
    expect(
      notices.some((notice) => notice.templateData.event === "recovery_codes_regenerated"),
    ).toBe(true);
  });

  test("blocks owner recovery codes and applies the restricted owner lifetime", async () => {
    await db.insert(identityRoleGrants).values({
      userId: "totp-boundary-user",
      role: "owner",
      state: "active",
      grantSource: "bootstrap_cli",
    });
    const recoveryPrimary = await post("/sign-in/email", {
      email: "totp-boundary@example.com",
      password: "totp boundary password long enough",
    });
    const blockedRecovery = await postWithCookie(
      "/two-factor/verify-recovery-code",
      { code: recoveryCodes[0] },
      responseCookieContaining(recoveryPrimary, "two_factor="),
    );
    expect(blockedRecovery.status).toBe(401);

    await db
      .update(identityTotpAuthenticators)
      .set({ lastUsedStep: null })
      .where(eq(identityTotpAuthenticators.userId, "totp-boundary-user"));
    const totpPrimary = await post("/sign-in/email", {
      email: "totp-boundary@example.com",
      password: "totp boundary password long enough",
    });
    const ownerTotp = await createOTP(totpSecret, { digits: 6, period: 30 }).totp();
    const signedIn = await postWithCookie(
      "/two-factor/verify-totp",
      { code: ownerTotp, trustDevice: false },
      responseCookieContaining(totpPrimary, "two_factor="),
    );
    expect(signedIn.status).toBe(200);
    const sessionCookie = responseCookieContaining(signedIn, "pawket.session=");
    expect(sessionCookie).not.toBe("");
    const resolved = (await auth.api.getSession({
      headers: new Headers({ cookie: sessionCookie }),
    })) as { session: { id: string } } | null;
    const [session] = await db
      .select()
      .from(identitySessions)
      .where(eq(identitySessions.id, resolved!.session.id))
      .limit(1);

    expect(session).toBeDefined();
    expect(session!.absoluteExpiresAt.getTime() - session!.createdAt.getTime()).toBe(
      12 * 60 * 60_000,
    );
    expect(session!.idleExpiresAt.getTime() - session!.lastUsedAt.getTime()).toBe(
      30 * 60_000,
    );

    const staleLastUse = new Date(Date.now() - 2 * 60_000);
    const staleIdle = new Date(staleLastUse.getTime() + 30 * 60_000);
    await db
      .update(identitySessions)
      .set({
        updatedAt: staleLastUse,
        lastUsedAt: staleLastUse,
        idleExpiresAt: staleIdle,
        expiresAt: staleIdle,
      })
      .where(eq(identitySessions.id, session!.id));
    await expect(
      auth.api.getSession({ headers: new Headers({ cookie: sessionCookie }) }),
    ).resolves.toEqual(
      expect.objectContaining({ user: expect.objectContaining({ id: "totp-boundary-user" }) }),
    );
    const [refreshed] = await db
      .select()
      .from(identitySessions)
      .where(eq(identitySessions.id, session!.id));
    expect(refreshed!.idleExpiresAt.getTime()).toBeGreaterThan(staleIdle.getTime());
    expect(refreshed!.idleExpiresAt.getTime() - refreshed!.lastUsedAt.getTime()).toBe(
      30 * 60_000,
    );
    expect(refreshed!.idleExpiresAt.getTime()).toBeLessThanOrEqual(
      refreshed!.absoluteExpiresAt.getTime(),
    );
  });

  test("uses a host-only non-secure cookie only for an explicit HTTP local origin", async () => {
    const localBaseURL = "http://localhost:3000";
    const localAuth = authExports.createPawketAuth!({
      db,
      baseURL: localBaseURL,
      trustedOrigins: [localBaseURL],
      secret: "local-auth-secret-at-least-32-characters",
      keyring: authKeyring,
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
