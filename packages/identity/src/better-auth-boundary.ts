import { randomUUID } from "node:crypto";

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { symmetricDecrypt, type SecretConfig } from "better-auth/crypto";
import { twoFactor } from "better-auth/plugins";
import { createOTP } from "@better-auth/utils/otp";

import {
  identityAccounts,
  identityEmailAddresses,
  identityRoleGrants,
  identitySessions,
  identityTotpAuthenticators,
  identityUsers,
  identityVerifications,
  type PawketDatabase,
  type PawketTransaction,
} from "@pawket/database";
import {
  constantTimeEqual,
  createLookupHmac,
  decryptSensitiveField,
  type EncryptionKeyring,
} from "@pawket/security";

import { hashPassword, verifyPassword } from "./auth-candidate/password.js";
import {
  createPawketAuthAdapter,
  hashSessionToken,
} from "./auth-candidate/session-token-adapter.js";
import {
  canonicalizeEmailAddress,
  isAllowedReturnPath,
  isTrustedMutationOrigin,
  resolveSessionCookie,
  resolveSessionPolicy,
} from "./core-identity-policy.js";
import {
  clearSecurityThrottle,
  normalizeUserAgentFamily,
  recordSecurityThrottleAttempt,
} from "./identity-repository.js";
import {
  beginExternalLinkTransaction,
  claimExternalLinkTransaction,
  consumeTotpStep,
  createRecoveryCodeBatchInTransaction,
  finalizeExternalLinkTransaction,
} from "./identity-security-repository.js";
import { pawketRecoveryCodePlugin } from "./recovery-code-plugin.js";
import { googleOidcNoncePlugin } from "./google-oidc-nonce-plugin.js";
import { socialMfaChallengePlugin } from "./social-mfa-plugin.js";
import { queueSecurityEmailHandoff } from "./security-email-handoff.js";

const POLICY_OWNED_PATHS = [
  "/change-email",
  "/change-password",
  "/delete-user",
  "/delete-user/callback",
  "/list-sessions",
  "/request-password-reset",
  "/reset-password",
  "/send-verification-email",
  "/sign-up/email",
  "/update-session",
  "/update-user",
  "/verify-email",
  "/verify-password",
  "/revoke-other-sessions",
  "/revoke-session",
  "/revoke-sessions",
] as const;

const TASK_THREE_HANDLER_PATHS = new Set([
  "/get-session",
  "/callback/discord",
  "/callback/google",
  "/link-social",
  "/list-accounts",
  "/sign-in/email",
  "/sign-in/social",
  "/sign-out",
  "/two-factor/enable",
  "/two-factor/regenerate-recovery-codes",
  "/two-factor/verify-recovery-code",
  "/two-factor/verify-totp",
  "/unlink-account",
]);

const authSchema = {
  identityAccounts,
  identityEmailAddresses,
  identitySessions,
  identityTotpAuthenticators,
  identityUsers,
  identityVerifications,
};

const sessionAdditionalFields = {
  assuranceState: { type: "string", required: true, input: false, returned: false },
  primaryAuthenticatedAt: { type: "date", required: false, input: false, returned: false },
  mfaVerifiedAt: { type: "date", required: false, input: false, returned: false },
  lastUsedAt: { type: "date", required: true, input: false, returned: false },
  absoluteExpiresAt: { type: "date", required: true, input: false, returned: false },
  idleExpiresAt: { type: "date", required: true, input: false, returned: false },
  authorizationVersion: { type: "number", required: true, input: false, returned: false },
  revokedAt: { type: "date", required: false, input: false, returned: false },
  revocationReason: { type: "string", required: false, input: false, returned: false },
} as const;

const userAdditionalFields = {
  canonicalEmail: { type: "string", required: false, input: false, returned: false },
  emailVerifiedAt: { type: "date", required: false, input: false, returned: false },
  emailVerificationProvenance: {
    type: "string",
    required: false,
    input: false,
    returned: false,
  },
  accessStatus: { type: "string", required: false, input: false, returned: false },
  authorizationVersion: { type: "number", required: false, input: false, returned: false },
  twoFactorEnabled: { type: "boolean", required: false, input: false, returned: false },
} as const;

export type AuthenticationThrottleAcceleration = {
  observe(input: {
    action: "password_sign_in";
    accountSubjectHmac: string;
    networkSubjectHmac: string;
    outcome: "allowed" | "denied" | "blocked";
  }): Promise<void>;
};

export type AuthenticationRiskHook = {
  evaluate(input: {
    action: "password_sign_in";
    accountSubjectHmac: string;
    networkSubjectHmac: string;
    authoritativeRisk: "normal" | "elevated" | "challenge_required";
  }): Promise<"allow" | "deny" | "bot_challenge">;
};

type PawketAuthSecretOptions =
  | {
      secrets: readonly { version: number; value: string }[];
      secret?: never;
      legacySecret?: string;
    }
  | {
      secret: string;
      secrets?: never;
      legacySecret?: never;
    };

type PawketAuthOptions = {
  db: PawketDatabase;
  baseURL: string;
  trustedOrigins: readonly string[];
  keyring: EncryptionKeyring;
  lookupHmacKey: Uint8Array;
  socialProviders?: {
    google?: { clientId: string; clientSecret: string };
    discord?: { clientId: string; clientSecret: string };
  };
  throttle?: { maximumAttempts: number; windowMs: number; blockMs: number };
  acceleration?: AuthenticationThrottleAcceleration;
  riskHook?: AuthenticationRiskHook;
} & PawketAuthSecretOptions;

export type PawketAuthBoundary = {
  handler(request: Request): Promise<Response>;
  enabledProviders: readonly ("google" | "discord")[];
  consumeOperationTelemetry(request: Request): AuthOperationTelemetry | null;
  api: {
    getSession(input: { headers: Headers }): Promise<unknown>;
  };
};

export type AuthOperationTelemetry = Readonly<{
  operation: "oauth_callback" | "security_change";
  outcome: "succeeded" | "rejected" | "retryable_failure";
}>;

function networkSource(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (forwarded || "unknown-network").slice(0, 256);
}

function authPath(request: Request): string {
  const pathname = new URL(request.url).pathname;
  return pathname.startsWith("/api/auth") ? pathname.slice("/api/auth".length) || "/" : pathname;
}

function fixedJson(status: number, code: string): Response {
  return Response.json(
    { code, message: "Authentication could not be completed" },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function clearMfaCookies(response: Response, sessionCookie: ReturnType<typeof resolveSessionCookie>): Response {
  const headers = new Headers(response.headers);
  const secure = sessionCookie.secure ? "; Secure" : "";
  headers.append(
    "set-cookie",
    `${sessionCookie.name}=; Max-Age=0; Path=/; HttpOnly${secure}; SameSite=Lax`,
  );
  headers.append(
    "set-cookie",
    `pawket.two_factor=; Max-Age=0; Path=/; HttpOnly${secure}; SameSite=Lax`,
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function appendSetCookies(response: Response, source: Response): Response {
  const headers = new Headers(response.headers);
  for (const cookie of source.headers.getSetCookie()) headers.append("set-cookie", cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function replaceRedirectLocation(response: Response, location: string): Response {
  const headers = new Headers(response.headers);
  headers.set("location", location);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function mfaContinuationLocation(response: Response, baseURL: string): string {
  const rawLocation = response.headers.get("location");
  let returnPath = "/settings/security";
  if (rawLocation) {
    try {
      const location = new URL(rawLocation, baseURL);
      const base = new URL(baseURL);
      const candidate = `${location.pathname}${location.search}`;
      if (location.origin === base.origin && isAllowedReturnPath(candidate)) returnPath = candidate;
    } catch {
      // Keep the fixed safe fallback.
    }
  }
  return `/sign-in/mfa?returnTo=${encodeURIComponent(returnPath)}`;
}

async function queueUserSecurityNoticeInTransaction(
  tx: PawketTransaction,
  input: {
    userId: string;
    event: string;
    keyring: EncryptionKeyring;
    now: Date;
  },
): Promise<void> {
  const [user] = await tx
    .select({ email: identityUsers.email })
    .from(identityUsers)
    .where(eq(identityUsers.id, input.userId))
    .limit(1);
  if (!user) throw new Error("Security notice user is unavailable");
  await queueSecurityEmailHandoff(tx, {
    id: randomUUID(),
    userId: input.userId,
    purpose: "security_notice",
    destination: user.email,
    templateData: { event: input.event, returnPath: "/settings/security" },
    keyring: input.keyring,
    now: input.now,
  });
}

async function rollbackIncompleteTotpEnrollment(
  db: PawketDatabase,
  input: { userId: string; authenticatorId: string; now: Date },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(identityTotpAuthenticators)
      .where(
        and(
          eq(identityTotpAuthenticators.id, input.authenticatorId),
          eq(identityTotpAuthenticators.userId, input.userId),
        ),
      );
    await tx
      .update(identityUsers)
      .set({
        twoFactorEnabled: false,
        authorizationVersion: sql`${identityUsers.authorizationVersion} + 1`,
        updatedAt: input.now,
      })
      .where(eq(identityUsers.id, input.userId));
    await tx
      .update(identitySessions)
      .set({
        assuranceState: "mfa_pending",
        revokedAt: input.now,
        revocationReason: "totp_enrollment_incomplete",
        updatedAt: input.now,
      })
      .where(
        and(
          eq(identitySessions.userId, input.userId),
          isNull(identitySessions.revokedAt),
        ),
      );
  });
}

async function matchedTotpStep(input: {
  db: PawketDatabase;
  keyring: EncryptionKeyring;
  authSecret: string | SecretConfig;
  userId: string;
  code: string;
  now: Date;
}): Promise<number | null> {
  const [authenticator] = await input.db
    .select({
      id: identityTotpAuthenticators.id,
      secret: identityTotpAuthenticators.secret,
      verified: identityTotpAuthenticators.verified,
    })
    .from(identityTotpAuthenticators)
    .where(eq(identityTotpAuthenticators.userId, input.userId))
    .limit(1);
  if (!authenticator?.verified) return null;
  const libraryCiphertext = decryptSensitiveField({
    envelope: authenticator.secret,
    binding: {
      recordType: "identity_totp_authenticator",
      recordId: authenticator.id,
      fieldName: "secret",
    },
    keyring: input.keyring,
  });
  const secret = await symmetricDecrypt({ key: input.authSecret, data: libraryCiphertext });
  const currentStep = Math.floor(input.now.getTime() / 30_000);
  const otp = createOTP(secret, { digits: 6, period: 30 });
  for (let offset = -1; offset <= 1; offset += 1) {
    const step = currentStep + offset;
    const candidate = await otp.hotp(step);
    if (
      constantTimeEqual(Buffer.from(input.code, "utf8"), Buffer.from(candidate, "utf8"))
    ) {
      return step;
    }
  }
  return null;
}

async function stripSessionToken(response: Response): Promise<Response> {
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    return response;
  }
  const payload = (await response.json()) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !("token" in payload)) {
    return new Response(JSON.stringify(payload), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  const safePayload = { ...(payload as Record<string, unknown>) };
  delete safePayload.token;
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(safePayload), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function requireTotpVerificationUserId(
  payload: unknown,
  expectedUserId?: string | null,
): string {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !("user" in payload) ||
    !payload.user ||
    typeof payload.user !== "object" ||
    Array.isArray(payload.user) ||
    !("id" in payload.user) ||
    typeof payload.user.id !== "string" ||
    payload.user.id.length === 0 ||
    payload.user.id !== payload.user.id.trim() ||
    (expectedUserId !== undefined && expectedUserId !== null && payload.user.id !== expectedUserId)
  ) {
    throw new Error("TOTP verification response has an invalid user");
  }
  return payload.user.id;
}

export async function parseRequiredJsonResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("Expected a JSON authentication response");
  }
  const payload = (await response.json()) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Expected an authentication response object");
  }
  return payload as Record<string, unknown>;
}

function appendValidatedJsonFields(
  response: Response,
  payload: Record<string, unknown>,
  fields: Record<string, unknown>,
): Response {
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify({ ...payload, ...fields }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function createPawketAuth(options: PawketAuthOptions): PawketAuthBoundary {
  const sessionCookie = resolveSessionCookie(options.baseURL);
  const enabledProviders = (["google", "discord"] as const).filter(
    (provider) => Boolean(options.socialProviders?.[provider]),
  );
  const configuredAuthSecrets =
    options.secrets !== undefined
      ? options.secrets.map(({ version, value }) => ({ version, value }))
      : [{ version: 0, value: options.secret }];
  const currentAuthSecret = configuredAuthSecrets[0];
  if (!currentAuthSecret) throw new Error("At least one authentication secret is required");
  const legacyAuthSecret =
    options.secrets !== undefined ? options.legacySecret : options.secret;
  const authSecretConfig: SecretConfig = {
    keys: new Map(configuredAuthSecrets.map(({ version, value }) => [version, value])),
    currentVersion: currentAuthSecret.version,
    ...(legacyAuthSecret ? { legacySecret: legacyAuthSecret } : {}),
  };
  const authSecretOptions = {
    secrets: configuredAuthSecrets,
    ...(legacyAuthSecret ? { secret: legacyAuthSecret } : {}),
  };
  const auth = betterAuth({
    appName: "Pawket",
    baseURL: options.baseURL,
    ...authSecretOptions,
    trustedOrigins: [...options.trustedOrigins],
    disabledPaths: [...POLICY_OWNED_PATHS],
    database: createPawketAuthAdapter(
      drizzleAdapter(options.db, {
        provider: "pg",
        schema: authSchema,
        transaction: true,
      }),
      { keyring: options.keyring, requireVerifiedSocialUser: true },
    ),
    user: {
      modelName: "identityUsers",
      additionalFields: userAdditionalFields,
    },
    session: {
      modelName: "identitySessions",
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 60,
      freshAge: 15 * 60,
      cookieCache: { enabled: false },
      additionalFields: sessionAdditionalFields,
    },
    account: {
      modelName: "identityAccounts",
      storeStateStrategy: "database",
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: false,
      },
    },
    verification: {
      modelName: "identityVerifications",
      storeIdentifier: "hashed",
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 15,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 1_800,
      revokeSessionsOnPasswordReset: true,
      password: { hash: hashPassword, verify: verifyPassword },
    },
    socialProviders: {
      ...(options.socialProviders?.google
        ? {
            google: {
              ...options.socialProviders.google,
              scope: ["openid", "email", "profile"],
              requireEmailVerification: true,
            },
          }
        : {}),
      ...(options.socialProviders?.discord
        ? {
            discord: {
              ...options.socialProviders.discord,
              scope: ["identify", "email"],
              requireEmailVerification: true,
            },
          }
        : {}),
    },
    rateLimit: { enabled: false },
    databaseHooks: {
      session: {
        create: {
          before: async (session, context) => {
            const [user] = await options.db
              .select({
                emailVerified: identityUsers.emailVerified,
                accessStatus: identityUsers.accessStatus,
                authorizationVersion: identityUsers.authorizationVersion,
                ownerGrantId: identityRoleGrants.id,
              })
              .from(identityUsers)
              .leftJoin(
                identityRoleGrants,
                and(
                  eq(identityRoleGrants.userId, identityUsers.id),
                  eq(identityRoleGrants.role, "owner"),
                  eq(identityRoleGrants.state, "active"),
                ),
              )
              .where(eq(identityUsers.id, session.userId))
              .limit(1);
            if (!user || !user.emailVerified || user.accessStatus !== "active") return false;

            const createdAt = session.createdAt instanceof Date ? session.createdAt : new Date();
            const policy = resolveSessionPolicy({
              kind: user.ownerGrantId ? "owner" : "user",
              now: createdAt,
            });
            return {
              data: {
                ...session,
                expiresAt: policy.idleExpiresAt,
                ipAddress:
                  typeof session.ipAddress === "string" && session.ipAddress.length > 0
                    ? createLookupHmac({
                        value: session.ipAddress.slice(0, 256),
                        context: "network-identity",
                        key: options.lookupHmacKey,
                      })
                    : null,
                userAgent: normalizeUserAgentFamily(
                  typeof session.userAgent === "string" ? session.userAgent : undefined,
                ),
                assuranceState: "active",
                primaryAuthenticatedAt: createdAt,
                mfaVerifiedAt:
                  context?.path === "/two-factor/verify-totp" ? createdAt : null,
                lastUsedAt: createdAt,
                absoluteExpiresAt: policy.absoluteExpiresAt,
                idleExpiresAt: policy.idleExpiresAt,
                authorizationVersion: user.authorizationVersion,
                revokedAt: null,
                revocationReason: null,
              },
            };
          },
        },
      },
    },
    plugins: [
      googleOidcNoncePlugin(),
      twoFactor({
        issuer: "Pawket",
        twoFactorTable: "identityTotpAuthenticators",
        twoFactorCookieMaxAge: 600,
        trustDeviceMaxAge: 0,
        allowPasswordless: true,
        accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 900 },
        backupCodeOptions: {
          amount: 0,
          customBackupCodesGenerate: () => [],
          storeBackupCodes: {
            async encrypt() {
              return "[]";
            },
            async decrypt() {
              return "[]";
            },
          },
        },
      }),
      socialMfaChallengePlugin(),
      pawketRecoveryCodePlugin({ db: options.db, keyring: options.keyring }),
    ],
    advanced: {
      useSecureCookies: false,
      cookiePrefix: "pawket",
      defaultCookieAttributes: {
        httpOnly: true,
        secure: sessionCookie.secure,
        sameSite: sessionCookie.sameSite,
        path: sessionCookie.path,
      },
      cookies: {
        session_token: {
          name: sessionCookie.name,
          attributes: {
            httpOnly: sessionCookie.httpOnly,
            secure: sessionCookie.secure,
            sameSite: sessionCookie.sameSite,
            path: sessionCookie.path,
          },
        },
      },
    },
  });

  const operationTelemetryByRequest = new WeakMap<Request, AuthOperationTelemetry>();
  const withOperationTelemetry = (
    request: Request,
    response: Response,
    telemetry: AuthOperationTelemetry,
  ): Response => {
    operationTelemetryByRequest.set(request, Object.freeze({ ...telemetry }));
    return response;
  };
  const baseHandler = auth.handler;
  const handler = async (request: Request): Promise<Response> => {
    const path = authPath(request);
    if (!TASK_THREE_HANDLER_PATHS.has(path)) {
      return fixedJson(404, "AUTHENTICATION_ROUTE_NOT_FOUND");
    }
    if (
      request.method !== "GET" &&
      !isTrustedMutationOrigin({
        origin: request.headers.get("origin"),
        trustedOrigins: options.trustedOrigins,
      })
    ) {
      return fixedJson(403, "UNTRUSTED_ORIGIN");
    }

    let totpVerification:
      | {
          code: string;
          hadAuthenticatedSession: boolean;
          authenticatedSessionId: string | null;
          enrollmentAuthenticatorId: string | null;
          userId: string | null;
        }
      | undefined;
    let externalLinkContext:
      | {
          userId: string;
          sessionId: string;
          provider: "google" | "discord";
          returnPath: string;
      }
      | undefined;
    let externalCallbackContext:
      | {
          id: string;
          userId: string;
          sessionId: string;
          provider: "google" | "discord";
          returnPath: string;
          preexistingAccountIds: readonly string[];
        }
      | undefined;

    const callbackProvider =
      path === "/callback/google"
        ? "google"
        : path === "/callback/discord"
          ? "discord"
          : null;
    let callbackTelemetry: AuthOperationTelemetry | undefined;
    if (callbackProvider) {
      const state = new URL(request.url).searchParams.get("state");
      if (state) {
        try {
          const resolved = (await auth.api.getSession({ headers: request.headers })) as
            | { session: { id: string }; user: { id: string } }
            | null;
          const claimed = await claimExternalLinkTransaction(options.db, {
            state,
            userId: resolved?.user.id ?? null,
            sessionId: resolved?.session.id ?? null,
            provider: callbackProvider,
            now: new Date(),
          });
          if (claimed.kind === "invalid") {
            return fixedJson(400, "EXTERNAL_LINK_TRANSACTION_INVALID");
          }
          if (claimed.kind === "not_found" && resolved) {
            return fixedJson(400, "EXTERNAL_LINK_TRANSACTION_INVALID");
          }
          if (claimed.kind === "claimed") {
            const preexisting = await options.db
              .select({ id: identityAccounts.id })
              .from(identityAccounts)
              .where(
                and(
                  eq(identityAccounts.userId, claimed.userId),
                  eq(identityAccounts.providerId, callbackProvider),
                ),
              );
            externalCallbackContext = {
              ...claimed,
              provider: callbackProvider,
              preexistingAccountIds: preexisting.map((account) => account.id),
            };
          }
        } catch {
          return fixedJson(503, "AUTHENTICATION_UNAVAILABLE");
        }
      }
    }
    if (path === "/two-factor/verify-totp" && request.method === "POST") {
      try {
        const body = (await request.clone().json()) as { code?: unknown };
        const existing = await auth.api.getSession({ headers: request.headers });
        if (typeof body.code === "string") {
          let enrollmentAuthenticatorId: string | null = null;
          let authenticatedSessionId: string | null = null;
          let userId: string | null = null;
          if (existing && typeof existing === "object" && "user" in existing) {
            const resolved = existing as {
              session?: { id?: unknown };
              user?: { id?: unknown };
            };
            const sessionUser = resolved.user;
            if (typeof resolved.session?.id === "string") {
              authenticatedSessionId = resolved.session.id;
            }
            if (typeof sessionUser?.id === "string") {
              userId = sessionUser.id;
              const [pending] = await options.db
                .select({
                  id: identityTotpAuthenticators.id,
                  verified: identityTotpAuthenticators.verified,
                })
                .from(identityTotpAuthenticators)
                .where(eq(identityTotpAuthenticators.userId, sessionUser.id))
                .limit(1);
              if (pending && !pending.verified) enrollmentAuthenticatorId = pending.id;
            }
          }
          totpVerification = {
            code: body.code,
            hadAuthenticatedSession: Boolean(existing),
            authenticatedSessionId,
            enrollmentAuthenticatorId,
            userId,
          };
        }
      } catch {
        // Better Auth returns the fixed malformed-request response.
      }
    }

    if (path === "/sign-in/social" || path === "/link-social") {
      try {
        const body = (await request.clone().json()) as {
          provider?: unknown;
          callbackURL?: unknown;
        };
        if (
          (body.provider !== "google" && body.provider !== "discord") ||
          !enabledProviders.includes(body.provider)
        ) {
          return fixedJson(404, "SOCIAL_PROVIDER_NOT_AVAILABLE");
        }
        if (typeof body.callbackURL !== "string" || !isAllowedReturnPath(body.callbackURL)) {
          return fixedJson(400, "INVALID_RETURN_PATH");
        }
        if (path === "/link-social") {
          externalLinkContext = {
            userId: "",
            sessionId: "",
            provider: body.provider,
            returnPath: body.callbackURL,
          };
        }
      } catch {
        return fixedJson(400, "INVALID_AUTHENTICATION_REQUEST");
      }
    }

    if (
      path === "/two-factor/enable" ||
      path === "/link-social" ||
      path === "/unlink-account"
    ) {
      try {
        const resolved = (await auth.api.getSession({ headers: request.headers })) as
          | { session: { id: string }; user: { id: string } }
          | null;
        if (!resolved) return fixedJson(401, "RECENT_PRIMARY_AUTHENTICATION_REQUIRED");
        const [recent] = await options.db
          .select({
            id: identitySessions.id,
            primaryAuthenticatedAt: identitySessions.primaryAuthenticatedAt,
            mfaVerifiedAt: identitySessions.mfaVerifiedAt,
            twoFactorEnabled: identityUsers.twoFactorEnabled,
          })
          .from(identitySessions)
          .innerJoin(identityUsers, eq(identityUsers.id, identitySessions.userId))
          .where(
            and(
              eq(identitySessions.id, resolved.session.id),
              eq(identitySessions.userId, resolved.user.id),
              isNull(identitySessions.revokedAt),
              gt(identitySessions.expiresAt, new Date()),
            ),
          )
          .limit(1);
        const now = Date.now();
        if (
          !recent?.primaryAuthenticatedAt ||
          now - recent.primaryAuthenticatedAt.getTime() > 15 * 60_000 ||
          (recent.twoFactorEnabled &&
            (!recent.mfaVerifiedAt || now - recent.mfaVerifiedAt.getTime() > 5 * 60_000))
        ) {
          return fixedJson(401, "RECENT_PRIMARY_AUTHENTICATION_REQUIRED");
        }
        if (externalLinkContext) {
          externalLinkContext.userId = resolved.user.id;
          externalLinkContext.sessionId = resolved.session.id;
        }
        if (path === "/unlink-account") {
          const body = (await request.clone().json()) as { accountId?: unknown };
          if (typeof body.accountId !== "string") {
            return fixedJson(400, "SOCIAL_IDENTITY_UNLINK_REJECTED");
          }
          const unlinked = await options.db.transaction(async (tx) => {
            await tx
              .select({ id: identityUsers.id })
              .from(identityUsers)
              .where(eq(identityUsers.id, resolved.user.id))
              .for("update");
            const accounts = await tx
              .select({
                id: identityAccounts.id,
                providerId: identityAccounts.providerId,
              })
              .from(identityAccounts)
              .where(eq(identityAccounts.userId, resolved.user.id));
            const target = accounts.find((account) => account.id === body.accountId);
            if (
              !target ||
              (target.providerId !== "google" && target.providerId !== "discord") ||
              accounts.length <= 1
            ) {
              return false;
            }
            await tx
              .delete(identityAccounts)
              .where(
                and(
                  eq(identityAccounts.id, target.id),
                  eq(identityAccounts.userId, resolved.user.id),
                ),
              );
            await queueUserSecurityNoticeInTransaction(tx, {
              userId: resolved.user.id,
              event: "social_identity_unlinked",
              keyring: options.keyring,
              now: new Date(),
            });
            return true;
          });
          if (!unlinked) return fixedJson(400, "SOCIAL_IDENTITY_UNLINK_REJECTED");
          return Response.json(
            { status: true },
            { headers: { "cache-control": "no-store" } },
          );
        }
      } catch {
        return fixedJson(503, "AUTHENTICATION_UNAVAILABLE");
      }
    }

    let signInSubjects:
      | { accountSubjectHmac: string; networkSubjectHmac: string }
      | undefined;
    if (path === "/sign-in/email" && request.method === "POST") {
      let body: { email?: unknown; callbackURL?: unknown } = {};
      try {
        body = (await request.clone().json()) as typeof body;
      } catch {
        // The protocol engine returns the fixed malformed-request response.
      }
      if (typeof body.callbackURL === "string" && !isAllowedReturnPath(body.callbackURL)) {
        return fixedJson(400, "INVALID_RETURN_PATH");
      }

      let canonicalEmail = "invalid-email";
      if (typeof body.email === "string") {
        try {
          canonicalEmail = canonicalizeEmailAddress(body.email).canonical;
        } catch {
          canonicalEmail = "invalid-email";
        }
      }
      signInSubjects = {
        accountSubjectHmac: createLookupHmac({
          value: canonicalEmail,
          context: "auth-account",
          key: options.lookupHmacKey,
        }),
        networkSubjectHmac: createLookupHmac({
          value: networkSource(request),
          context: "auth-network",
          key: options.lookupHmacKey,
        }),
      };
      const policy = options.throttle ?? {
        maximumAttempts: 10,
        windowMs: 15 * 60_000,
        blockMs: 15 * 60_000,
      };
      try {
        const [account, network] = await Promise.all([
          recordSecurityThrottleAttempt(options.db, {
            scope: "account",
            subjectHmac: signInSubjects.accountSubjectHmac,
            action: "password_sign_in",
            now: new Date(),
            ...policy,
          }),
          recordSecurityThrottleAttempt(options.db, {
            scope: "network",
            subjectHmac: signInSubjects.networkSubjectHmac,
            action: "password_sign_in",
            now: new Date(),
            ...policy,
          }),
        ]);
        const risk = account.risk === "challenge_required" || network.risk === "challenge_required"
          ? "challenge_required"
          : account.risk === "elevated" || network.risk === "elevated"
            ? "elevated"
            : "normal";
        const hookDecision = options.riskHook
          ? await options.riskHook.evaluate({
              action: "password_sign_in",
              ...signInSubjects,
              authoritativeRisk: risk,
            })
          : "allow";
        if (!account.allowed || !network.allowed || hookDecision !== "allow") {
          void options.acceleration
            ?.observe({ action: "password_sign_in", ...signInSubjects, outcome: "blocked" })
            .catch(() => undefined);
          return fixedJson(429, "AUTHENTICATION_RATE_LIMITED");
        }
      } catch {
        return fixedJson(503, "AUTHENTICATION_UNAVAILABLE");
      }
    }

    let response: Response;
    try {
      response = await baseHandler(request);
    } catch {
      if (externalCallbackContext) {
        await options.db
          .transaction(async (tx) => {
            const currentAccounts = await tx
              .select({ id: identityAccounts.id })
              .from(identityAccounts)
              .where(
                and(
                  eq(identityAccounts.userId, externalCallbackContext.userId),
                  eq(identityAccounts.providerId, externalCallbackContext.provider),
                ),
              );
            const newlyCreatedIds = currentAccounts
              .map((account) => account.id)
              .filter(
                (id) => !externalCallbackContext.preexistingAccountIds.includes(id),
              );
            for (const accountId of newlyCreatedIds) {
              await tx
                .delete(identityAccounts)
                .where(
                  and(
                    eq(identityAccounts.id, accountId),
                    eq(identityAccounts.userId, externalCallbackContext.userId),
                    eq(identityAccounts.providerId, externalCallbackContext.provider),
                  ),
                );
            }
            await finalizeExternalLinkTransaction(tx, {
              id: externalCallbackContext.id,
              outcome: "conflict",
              resultCode: "callback_failed_rolled_back",
              now: new Date(),
            });
          })
          .catch(() => undefined);
      }
      const unavailable = fixedJson(503, "AUTHENTICATION_UNAVAILABLE");
      return callbackProvider
        ? withOperationTelemetry(request, unavailable, {
            operation: externalCallbackContext ? "security_change" : "oauth_callback",
            outcome: "retryable_failure",
          })
        : unavailable;
    }

    if (externalCallbackContext) {
      let linkedAccountToCompensate: string | null = null;
      try {
        const location = response.headers.get("location");
        const expectedReturn = new URL(externalCallbackContext.returnPath, options.baseURL);
        const actualReturn = location ? new URL(location, options.baseURL) : null;
        const linkedAccounts = await options.db
          .select({ id: identityAccounts.id })
          .from(identityAccounts)
          .where(
            and(
              eq(identityAccounts.userId, externalCallbackContext.userId),
              eq(identityAccounts.providerId, externalCallbackContext.provider),
            ),
          );
        const newlyLinked = linkedAccounts.find(
          (account) => !externalCallbackContext.preexistingAccountIds.includes(account.id),
        );
        const linked = newlyLinked ?? linkedAccounts[0];
        const completed =
          response.status >= 300 &&
          response.status < 400 &&
          actualReturn?.href === expectedReturn.href &&
          Boolean(linked);
        linkedAccountToCompensate = newlyLinked?.id ?? null;
        if (completed) {
          const completedWithNotice = await options.db.transaction(async (tx) => {
            const completedTransaction = await finalizeExternalLinkTransaction(tx, {
              id: externalCallbackContext.id,
              outcome: "completed",
              resultCode: "linked",
              now: new Date(),
            });
            if (!completedTransaction) return false;
            await queueUserSecurityNoticeInTransaction(tx, {
              userId: externalCallbackContext.userId,
              event: "social_identity_linked",
              keyring: options.keyring,
              now: new Date(),
            });
            return true;
          });
          if (!completedWithNotice) throw new Error("External link completion was not claimable");
          callbackTelemetry = { operation: "security_change", outcome: "succeeded" };
        } else {
          const rejectedLinkedAccountId = linkedAccountToCompensate;
          const finalized = await options.db.transaction(async (tx) => {
            if (rejectedLinkedAccountId) {
              await tx
                .delete(identityAccounts)
                .where(
                  and(
                    eq(identityAccounts.id, rejectedLinkedAccountId),
                    eq(identityAccounts.userId, externalCallbackContext.userId),
                    eq(identityAccounts.providerId, externalCallbackContext.provider),
                  ),
                );
            }
            return finalizeExternalLinkTransaction(tx, {
              id: externalCallbackContext.id,
              outcome: "conflict",
              resultCode: "callback_rejected",
              now: new Date(),
            });
          });
          if (!finalized) {
            return withOperationTelemetry(
              request,
              fixedJson(400, "EXTERNAL_LINK_TRANSACTION_INVALID"),
              { operation: "security_change", outcome: "rejected" },
            );
          }
          callbackTelemetry = { operation: "security_change", outcome: "rejected" };
        }
      } catch {
        const compensatingAccountId = linkedAccountToCompensate;
        if (compensatingAccountId) {
          await options.db
            .transaction(async (tx) => {
              await tx
                .delete(identityAccounts)
                .where(
                  and(
                    eq(identityAccounts.id, compensatingAccountId),
                    eq(identityAccounts.userId, externalCallbackContext.userId),
                    eq(identityAccounts.providerId, externalCallbackContext.provider),
                  ),
                );
              await finalizeExternalLinkTransaction(tx, {
                id: externalCallbackContext.id,
                outcome: "conflict",
                resultCode: "notice_failed_rolled_back",
                now: new Date(),
              });
            })
            .catch(() => undefined);
        }
        return withOperationTelemetry(
          request,
          fixedJson(503, "AUTHENTICATION_UNAVAILABLE"),
          { operation: "security_change", outcome: "retryable_failure" },
        );
      }
    }

    if (callbackProvider && !externalCallbackContext) {
      if (response.status >= 300 && response.status < 400) {
        const createdSessionCookie = response.headers
          .getSetCookie()
          .map((value) => value.split(";", 1)[0] ?? "")
          .find((value) => value.startsWith(`${sessionCookie.name}=`) && value !== `${sessionCookie.name}=`);
        if (createdSessionCookie) {
          try {
            const createdSession = (await auth.api.getSession({
              headers: new Headers({ cookie: createdSessionCookie }),
            })) as
              | {
                  session: { id: string };
                  user: { id: string; email: string; emailVerified: boolean };
                }
              | null;
            if (!createdSession?.user.emailVerified) {
              return withOperationTelemetry(
                request,
                clearMfaCookies(fixedJson(503, "AUTHENTICATION_UNAVAILABLE"), sessionCookie),
                { operation: "oauth_callback", outcome: "retryable_failure" },
              );
            }
            const email = canonicalizeEmailAddress(createdSession.user.email);
            const now = new Date();
            await options.db
              .insert(identityEmailAddresses)
              .values({
                userId: createdSession.user.id,
                displayEmail: email.display,
                canonicalEmail: email.canonical,
                status: "primary",
                verifiedAt: now,
                verificationProvenance: "provider_assertion",
                createdAt: now,
                updatedAt: now,
              })
              .onConflictDoNothing();
            const [primaryEmail] = await options.db
              .select({ userId: identityEmailAddresses.userId })
              .from(identityEmailAddresses)
              .where(
                and(
                  eq(identityEmailAddresses.userId, createdSession.user.id),
                  eq(identityEmailAddresses.status, "primary"),
                ),
              )
              .limit(1);
            if (!primaryEmail) {
              await options.db
                .delete(identitySessions)
                .where(eq(identitySessions.id, createdSession.session.id));
              return withOperationTelemetry(
                request,
                clearMfaCookies(fixedJson(503, "AUTHENTICATION_UNAVAILABLE"), sessionCookie),
                { operation: "oauth_callback", outcome: "retryable_failure" },
              );
            }
            const challenge = await auth.api.beginSocialMfaChallenge({
              headers: new Headers({ cookie: createdSessionCookie }),
              body: {},
              asResponse: true,
            });
            if (!challenge.ok) {
              return withOperationTelemetry(
                request,
                clearMfaCookies(fixedJson(503, "AUTHENTICATION_UNAVAILABLE"), sessionCookie),
                { operation: "oauth_callback", outcome: "retryable_failure" },
              );
            }
            const payload = (await challenge.clone().json()) as { challenged?: unknown };
            if (payload.challenged === true) {
              response = replaceRedirectLocation(
                appendSetCookies(response, challenge),
                mfaContinuationLocation(response, options.baseURL),
              );
            }
            callbackTelemetry = { operation: "oauth_callback", outcome: "succeeded" };
          } catch {
            return withOperationTelemetry(
              request,
              clearMfaCookies(fixedJson(503, "AUTHENTICATION_UNAVAILABLE"), sessionCookie),
              { operation: "oauth_callback", outcome: "retryable_failure" },
            );
          }
        } else {
          callbackTelemetry = { operation: "oauth_callback", outcome: "rejected" };
        }
      } else {
        callbackTelemetry = {
          operation: "oauth_callback",
          outcome: response.status >= 500 ? "retryable_failure" : "rejected",
        };
      }
    }

    if (response.ok && externalLinkContext) {
      try {
        const payload = (await response.clone().json()) as { url?: unknown };
        if (typeof payload.url !== "string") {
          return fixedJson(503, "AUTHENTICATION_UNAVAILABLE");
        }
        const state = new URL(payload.url).searchParams.get("state");
        if (!state) return fixedJson(503, "AUTHENTICATION_UNAVAILABLE");
        await beginExternalLinkTransaction(options.db, {
          ...externalLinkContext,
          state,
          now: new Date(),
        });
      } catch {
        return fixedJson(503, "AUTHENTICATION_UNAVAILABLE");
      }
    }

    if (response.ok && path === "/two-factor/verify-totp" && totpVerification) {
      try {
        const payload = await parseRequiredJsonResponse(response.clone());
        const verifiedUserId = requireTotpVerificationUserId(
          payload,
          totpVerification.userId,
        );
        const acceptedStep = await matchedTotpStep({
          db: options.db,
          keyring: options.keyring,
          authSecret: authSecretConfig,
          userId: verifiedUserId,
          code: totpVerification.code,
          now: new Date(),
        });
        const accepted =
          acceptedStep !== null &&
          (await consumeTotpStep(options.db, {
            userId: verifiedUserId,
            step: acceptedStep,
            now: new Date(),
          }));
        if (!accepted) {
          if (!totpVerification.hadAuthenticatedSession && typeof payload.token === "string") {
            await options.db
              .delete(identitySessions)
              .where(eq(identitySessions.token, hashSessionToken(payload.token)));
          }
          return clearMfaCookies(fixedJson(401, "TOTP_REPLAY_REJECTED"), sessionCookie);
        }
        if (totpVerification.authenticatedSessionId) {
          await options.db
            .update(identitySessions)
            .set({
              mfaVerifiedAt: new Date(),
              assuranceState: "active",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(identitySessions.id, totpVerification.authenticatedSessionId),
                eq(identitySessions.userId, verifiedUserId),
                isNull(identitySessions.revokedAt),
              ),
            );
        }
        if (totpVerification.enrollmentAuthenticatorId) {
          const enrollmentNow = new Date();
          const recovery = await options.db.transaction(async (tx) => {
            const created = await createRecoveryCodeBatchInTransaction(tx, {
              authenticatorId: totpVerification.enrollmentAuthenticatorId!,
              now: enrollmentNow,
            });
            await queueUserSecurityNoticeInTransaction(tx, {
              userId: verifiedUserId,
              event: "totp_enrolled",
              keyring: options.keyring,
              now: enrollmentNow,
            });
            return created;
          });
          response = appendValidatedJsonFields(
            response,
            payload,
            { recoveryCodes: recovery.codes },
          );
        }
      } catch {
        if (totpVerification.enrollmentAuthenticatorId && totpVerification.userId) {
          await rollbackIncompleteTotpEnrollment(options.db, {
            userId: totpVerification.userId,
            authenticatorId: totpVerification.enrollmentAuthenticatorId,
            now: new Date(),
          }).catch(() => undefined);
        }
        return clearMfaCookies(
          fixedJson(503, "AUTHENTICATION_UNAVAILABLE"),
          sessionCookie,
        );
      }
    }

    if (signInSubjects) {
      const outcome = response.ok ? "allowed" : "denied";
      if (response.ok) {
        await Promise.all([
          clearSecurityThrottle(options.db, {
            scope: "account",
            subjectHmac: signInSubjects.accountSubjectHmac,
            action: "password_sign_in",
          }),
          clearSecurityThrottle(options.db, {
            scope: "network",
            subjectHmac: signInSubjects.networkSubjectHmac,
            action: "password_sign_in",
          }),
        ]).catch(() => undefined);
      }
      void options.acceleration
        ?.observe({ action: "password_sign_in", ...signInSubjects, outcome })
        .catch(() => undefined);
    }
    const safeResponse = await stripSessionToken(response);
    return callbackTelemetry
      ? withOperationTelemetry(request, safeResponse, callbackTelemetry)
      : safeResponse;
  };

  return {
    handler,
    enabledProviders,
    consumeOperationTelemetry(request) {
      const telemetry = operationTelemetryByRequest.get(request) ?? null;
      operationTelemetryByRequest.delete(request);
      return telemetry;
    },
    api: {
      getSession: (input) => auth.api.getSession(input),
    },
  };
}
