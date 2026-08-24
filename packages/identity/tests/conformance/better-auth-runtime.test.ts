import { betterAuth } from "better-auth";
import { memoryAdapter, type MemoryDB } from "better-auth/adapters/memory";
import { twoFactor } from "better-auth/plugins";
import { convertSetCookieToCookie } from "better-auth/test";
import { base32 } from "@better-auth/utils/base32";
import { describe, expect, test } from "vitest";
import { createEncryptionKeyring } from "@pawket/security";

import { candidateAuthPolicy } from "../../src/auth-candidate/identity-policy.js";
import { hashPassword, verifyPassword } from "../../src/auth-candidate/password.js";
import {
  createPawketAuthAdapter,
  hashSessionToken,
} from "../../src/auth-candidate/session-token-adapter.js";
import {
  candidateSessionAdditionalFields,
  sessionAssuranceForPath,
} from "../../src/auth-candidate/session-fields.js";

const baseURL = "http://localhost:3000";
const secret = "local-conformance-secret-at-least-32-characters";
const keyring = createEncryptionKeyring({
  activeKeyId: "conformance-v1",
  keys: { "conformance-v1": Uint8Array.from({ length: 32 }, (_, index) => index + 1) },
});

function createAuth(
  db: MemoryDB,
  requireEmailVerification = false,
  sendResetPassword?: (data: { token: string; url: string }) => Promise<void>,
) {
  for (const model of ["user", "account", "session", "verification", "twoFactor"] as const) {
    db[model] ??= [];
  }
  return betterAuth({
    appName: "Pawket",
    baseURL,
    secret,
    database: createPawketAuthAdapter(memoryAdapter(db), { keyring }),
    emailAndPassword: {
      ...candidateAuthPolicy.emailAndPassword,
      requireEmailVerification,
      autoSignIn: !requireEmailVerification,
      password: { hash: hashPassword, verify: verifyPassword },
      sendResetPassword: sendResetPassword
        ? async ({ token, url }) => sendResetPassword({ token, url })
        : undefined,
    },
    account: candidateAuthPolicy.account,
    session: {
      ...candidateAuthPolicy.session,
      additionalFields: candidateSessionAdditionalFields,
    },
    verification: candidateAuthPolicy.verification,
    databaseHooks: {
      session: {
        create: {
          before: async (session, context) => ({
            data: {
              ...session,
              ...sessionAssuranceForPath(context?.path ?? "", new Date()),
            },
          }),
        },
      },
    },
    advanced: {
      useSecureCookies: true,
      cookiePrefix: "pawket",
      cookies: {
        session_token: {
          name: "__Host-pawket.session",
          attributes: {
            httpOnly: true,
            secure: true,
            sameSite: "lax",
            path: "/",
          },
        },
      },
    },
    plugins: [
      twoFactor({
        issuer: "Pawket",
        twoFactorCookieMaxAge: 600,
        trustDeviceMaxAge: 0,
        accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 900 },
        backupCodeOptions: {
          amount: 0,
          customBackupCodesGenerate: () => [],
          storeBackupCodes: "encrypted",
        },
      }),
    ],
  });
}

async function post(auth: ReturnType<typeof createAuth>, path: string, body: unknown, headers?: Headers) {
  return auth.handler(
    new Request(`${baseURL}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseURL,
        ...(headers?.get("cookie") ? { cookie: headers.get("cookie")! } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("Better Auth 1.7.1 runtime conformance", () => {
  test("actual sign-up stores a hash while the signed cookie resolves and revocation is immediate", async () => {
    const db: MemoryDB = {};
    const auth = createAuth(db);
    const response = await post(auth, "/sign-up/email", {
      email: "artist@example.com",
      name: "Artist",
      password: "a sufficiently long password",
    });
    const payload = (await response.json()) as { token: string };

    expect(response.status).toBe(200);
    expect(payload.token).toBeTruthy();
    expect(db.session?.[0]?.token).toBe(hashSessionToken(payload.token));
    expect(db.session?.[0]?.mfaVerifiedAt).toBeNull();
    expect(JSON.stringify(db)).not.toContain(payload.token);

    const cookieHeaders = convertSetCookieToCookie(response.headers);
    const session = await auth.api.getSession({ headers: cookieHeaders });
    expect(session?.user.email).toBe("artist@example.com");

    await auth.api.revokeSession({
      headers: cookieHeaders,
      body: { token: payload.token },
    });
    await expect(auth.api.getSession({ headers: cookieHeaders })).resolves.toBeNull();
  });

  test("TOTP enrollment stores an encrypted seed and no library recovery codes", async () => {
    const db: MemoryDB = {};
    const auth = createAuth(db);
    const signUp = await post(auth, "/sign-up/email", {
      email: "owner@example.com",
      name: "Owner",
      password: "another sufficiently long password",
    });
    const cookieHeaders = convertSetCookieToCookie(signUp.headers);

    const enrollmentResponse = await post(
      auth,
      "/two-factor/enable",
      { password: "another sufficiently long password", method: "totp" },
      cookieHeaders,
    );
    const enrollment = (await enrollmentResponse.json()) as {
      totpURI: string;
      backupCodes: string[];
    };
    const enrolledCookie = enrollmentResponse.headers.has("set-cookie")
      ? convertSetCookieToCookie(enrollmentResponse.headers)
      : cookieHeaders;
    const encodedSecret = new URL(enrollment.totpURI).searchParams.get("secret");
    const rawSecret = Buffer.from(base32.decode(encodedSecret!)).toString("utf8");
    const code = (
      await auth.api.generateTOTP({
        body: { secret: rawSecret },
      })
    ).code;
    const verifyResponse = await post(
      auth,
      "/two-factor/verify-totp",
      { code, trustDevice: false },
      enrolledCookie,
    );
    const verifiedCookie = convertSetCookieToCookie(verifyResponse.headers);
    const stored = db.twoFactor?.[0];

    expect(verifyResponse.status).toBe(200);
    expect(enrollment.backupCodes).toEqual([]);
    expect(encodedSecret).toBeTruthy();
    expect(stored?.secret).toEqual(
      expect.objectContaining({ version: 1, algorithm: "A256GCM", keyId: "conformance-v1" }),
    );
    expect(stored?.backupCodes).not.toContain("-");
    expect(JSON.stringify(db)).not.toContain(encodedSecret);
    expect(db.session?.[0]?.mfaVerifiedAt).toBeInstanceOf(Date);

    await post(auth, "/sign-out", {}, verifiedCookie);
    const signIn = await post(auth, "/sign-in/email", {
      email: "owner@example.com",
      password: "another sufficiently long password",
    });
    const pendingCookie = convertSetCookieToCookie(signIn.headers);
    await expect(signIn.json()).resolves.toEqual(
      expect.objectContaining({ twoFactorRedirect: true, twoFactorMethods: ["totp"] }),
    );
    expect(db.session).toHaveLength(0);

    const incorrectCode = code === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await post(
        auth,
        "/two-factor/verify-totp",
        { code: incorrectCode, trustDevice: false },
        pendingCookie,
      );
    }
    expect(db.twoFactor?.[0]?.failedVerificationCount).toBe(5);
    expect(db.twoFactor?.[0]?.lockedUntil).toBeInstanceOf(Date);
    const blockedCorrectCode = await post(
      auth,
      "/two-factor/verify-totp",
      { code, trustDevice: false },
      pendingCookie,
    );
    expect(blockedCorrectCode.status).toBe(429);
  });

  test("duplicate registration remains enumeration-safe when verification is required", async () => {
    const db: MemoryDB = {};
    const auth = createAuth(db, true);
    const body = {
      email: "existing@example.com",
      name: "Existing",
      password: "a third sufficiently long password",
    };

    const first = await post(auth, "/sign-up/email", body);
    const duplicate = await post(auth, "/sign-up/email", body);

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    await expect(first.json()).resolves.toEqual(expect.objectContaining({ token: null }));
    await expect(duplicate.json()).resolves.toEqual(expect.objectContaining({ token: null }));
  });

  test("reset tokens are hashed, single-use, and revoke existing sessions", async () => {
    const db: MemoryDB = {};
    let resetToken = "";
    const auth = createAuth(db, false, async ({ token }) => {
      resetToken = token;
    });
    const signUp = await post(auth, "/sign-up/email", {
      email: "reset@example.com",
      name: "Reset",
      password: "reset password long enough",
    });
    const cookieHeaders = convertSetCookieToCookie(signUp.headers);

    const knownRequest = await post(auth, "/request-password-reset", {
      email: "reset@example.com",
      redirectTo: "/reset-password",
    });
    const unknownRequest = await post(auth, "/request-password-reset", {
      email: "unknown@example.com",
      redirectTo: "/reset-password",
    });

    expect(resetToken).toBeTruthy();
    expect(knownRequest.status).toBe(200);
    expect(unknownRequest.status).toBe(knownRequest.status);
    await expect(unknownRequest.json()).resolves.toEqual(await knownRequest.json());
    expect(JSON.stringify(db.verification)).not.toContain(resetToken);
    await auth.api.resetPassword({
      body: { token: resetToken, newPassword: "replacement password long enough" },
    });
    await expect(
      auth.api.resetPassword({
        body: { token: resetToken, newPassword: "another replacement long enough" },
      }),
    ).rejects.toThrow();
    await expect(auth.api.getSession({ headers: cookieHeaders })).resolves.toBeNull();
  });
});
