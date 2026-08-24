import { eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import {
  identityAccounts,
  identitySessions,
  identityUsers,
  identityVerifications,
  type PawketDatabase,
} from "@pawket/database";
import { createLookupHmac } from "@pawket/security";

import { hashPassword, verifyPassword } from "./auth-candidate/password.js";
import { createPawketAuthAdapter } from "./auth-candidate/session-token-adapter.js";
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

const TASK_TWO_HANDLER_PATHS = new Set(["/get-session", "/sign-in/email", "/sign-out"]);

const authSchema = {
  identityAccounts,
  identitySessions,
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
  canonicalEmail: { type: "string", required: true, input: false, returned: false },
  emailVerifiedAt: { type: "date", required: false, input: false, returned: false },
  emailVerificationProvenance: {
    type: "string",
    required: false,
    input: false,
    returned: false,
  },
  accessStatus: { type: "string", required: true, input: false, returned: false },
  authorizationVersion: { type: "number", required: true, input: false, returned: false },
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

type PawketAuthOptions = {
  db: PawketDatabase;
  baseURL: string;
  trustedOrigins: readonly string[];
  secret: string;
  lookupHmacKey: Uint8Array;
  throttle?: { maximumAttempts: number; windowMs: number; blockMs: number };
  acceleration?: AuthenticationThrottleAcceleration;
  riskHook?: AuthenticationRiskHook;
};

export type PawketAuthBoundary = {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(input: { headers: Headers }): Promise<unknown>;
  };
};

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

export function createPawketAuth(options: PawketAuthOptions): PawketAuthBoundary {
  const sessionCookie = resolveSessionCookie(options.baseURL);
  const auth = betterAuth({
    appName: "Pawket",
    baseURL: options.baseURL,
    secret: options.secret,
    trustedOrigins: [...options.trustedOrigins],
    disabledPaths: [...POLICY_OWNED_PATHS],
    database: createPawketAuthAdapter(
      drizzleAdapter(options.db, {
        provider: "pg",
        schema: authSchema,
        transaction: true,
      }),
    ),
    user: {
      modelName: "identityUsers",
      additionalFields: userAdditionalFields,
    },
    session: {
      modelName: "identitySessions",
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
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
    rateLimit: { enabled: false },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const [user] = await options.db
              .select({
                emailVerified: identityUsers.emailVerified,
                accessStatus: identityUsers.accessStatus,
                authorizationVersion: identityUsers.authorizationVersion,
              })
              .from(identityUsers)
              .where(eq(identityUsers.id, session.userId))
              .limit(1);
            if (!user || !user.emailVerified || user.accessStatus !== "active") return false;

            const createdAt = session.createdAt instanceof Date ? session.createdAt : new Date();
            const policy = resolveSessionPolicy({ kind: "user", now: createdAt });
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
                mfaVerifiedAt: null,
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
    advanced: {
      useSecureCookies: sessionCookie.secure,
      cookiePrefix: "pawket",
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

  const baseHandler = auth.handler;
  const handler = async (request: Request): Promise<Response> => {
    const path = authPath(request);
    if (!TASK_TWO_HANDLER_PATHS.has(path)) {
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
      return fixedJson(503, "AUTHENTICATION_UNAVAILABLE");
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
      response = await stripSessionToken(response);
    }
    return response;
  };

  return {
    handler,
    api: {
      getSession: (input) => auth.api.getSession(input),
    },
  };
}
