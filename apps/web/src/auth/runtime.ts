import { resolveOwnerSessionPermission } from "@pawket/admin";
import { loadServerEnv } from "@pawket/config";
import { createDatabase } from "@pawket/database";
import {
  createIdentityHttpHandlers,
  createCreatorApplicationHttpHandlers,
  createCreatorApplicationService,
  createIdentityService,
  createPawketAuth,
  getIdentityUserSummary,
  listUserSessions,
  recordSecurityThrottleAttempt,
  resolveSessionCookie,
  resolveAuthoritativeSessionById,
  revokeAllUserSessions,
  revokeUserSession,
} from "@pawket/identity";
import { createEncryptionKeyring, createLookupHmac } from "@pawket/security";

type WebIdentityRuntime = {
  auth: ReturnType<typeof createPawketAuth>;
  handlers: ReturnType<typeof createIdentityHttpHandlers>;
  creatorHandlers: ReturnType<typeof createCreatorApplicationHttpHandlers>;
  authenticate(headers: Headers): Promise<{
    userId: string;
    sessionId: string;
    primaryAuthenticatedAt: Date;
  } | null>;
  authorizeOwner(headers: Headers): Promise<"authorized" | "forbidden" | "unauthenticated">;
};

let runtime: WebIdentityRuntime | undefined;

export function isSecurityEmailDeliveryAvailable(
  adapter: "disabled" | "local" | "smtp",
): boolean {
  return adapter !== "disabled";
}

export function createRuntimeCompromisedPasswordChecker(
  appEnv: "local" | "test" | "staging" | "production",
): { isCompromised(password: string): Promise<boolean> } {
  return {
    async isCompromised(password): Promise<boolean> {
      void password;
      if (appEnv === "staging" || appEnv === "production") {
        throw new Error("Compromised password check is unavailable");
      }
      return false;
    },
  };
}

export function getIdentityRuntime(): WebIdentityRuntime {
  if (runtime) return runtime;

  const env = loadServerEnv();
  const database = createDatabase(env.DATABASE_URL);
  const keyring = createEncryptionKeyring({
    activeKeyId: env.PII_ACTIVE_KEY_ID,
    keys: Object.fromEntries(
      Object.entries(env.PII_KEYRING_JSON).map(([keyId, key]) => [
        keyId,
        Buffer.from(key, "base64"),
      ]),
    ),
  });
  const lookupHmacKey = Buffer.from(env.PII_LOOKUP_HMAC_KEY, "base64");
  const emailDeliveryAvailable = isSecurityEmailDeliveryAvailable(env.SECURITY_EMAIL_ADAPTER);
  const auth = createPawketAuth({
    db: database.db,
    baseURL: env.APP_BASE_URL,
    trustedOrigins: env.AUTH_TRUSTED_ORIGINS,
    secret: env.BETTER_AUTH_SECRETS[0]!,
    keyring,
    lookupHmacKey,
    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
            },
          }
        : {}),
      ...(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET
        ? {
            discord: {
              clientId: env.DISCORD_CLIENT_ID,
              clientSecret: env.DISCORD_CLIENT_SECRET,
            },
          }
        : {}),
    },
  });
  const service = createIdentityService({
    db: database.db,
    keyring,
    lookupHmacKey,
    compromisedPasswordChecker: createRuntimeCompromisedPasswordChecker(env.APP_ENV),
  });
  const creatorService = createCreatorApplicationService({ db: database.db, keyring });

  async function authenticate(headers: Headers) {
    const resolved = (await auth.api.getSession({ headers })) as
      | { session: { id: string }; user: { id: string } }
      | null;
    if (!resolved) return null;
    return resolveAuthoritativeSessionById(database.db, {
      sessionId: resolved.session.id,
      userId: resolved.user.id,
      now: new Date(),
    });
  }

  const handlers = createIdentityHttpHandlers({
    trustedOrigins: env.AUTH_TRUSTED_ORIGINS,
    emailDeliveryAvailable,
    sessionCookie: resolveSessionCookie(env.APP_BASE_URL),
    service,
    authenticate,
    getMe: (userId) => getIdentityUserSummary(database.db, userId),
    listSessions: (userId, now) => listUserSessions(database.db, { userId, now }),
    revokeSession: (input) => revokeUserSession(database.db, input),
    revokeAllSessions: (input) =>
      database.db.transaction((tx) => revokeAllUserSessions(tx, input)),
    async throttle({ action, accountSubject, request }) {
      const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
      const networkSubject = (forwarded || "unknown-network").slice(0, 256);
      const accountSubjectHmac = createLookupHmac({
        value: accountSubject.slice(0, 2_048),
        context: "auth-account",
        key: lookupHmacKey,
      });
      const networkSubjectHmac = createLookupHmac({
        value: networkSubject,
        context: "auth-network",
        key: lookupHmacKey,
      });
      const throttlePolicy = {
        action,
        now: new Date(),
        windowMs: 15 * 60_000,
        maximumAttempts: 5,
        blockMs: 15 * 60_000,
      };
      const [account, network] = await Promise.all([
        recordSecurityThrottleAttempt(database.db, {
          ...throttlePolicy,
          scope: "account",
          subjectHmac: accountSubjectHmac,
        }),
        recordSecurityThrottleAttempt(database.db, {
          ...throttlePolicy,
          scope: "network",
          subjectHmac: networkSubjectHmac,
        }),
      ]);
      return { allowed: account.allowed && network.allowed };
    },
  });
  const creatorHandlers = createCreatorApplicationHttpHandlers({
    trustedOrigins: env.AUTH_TRUSTED_ORIGINS,
    authenticate,
    service: creatorService,
  });

  runtime = {
    auth,
    handlers,
    creatorHandlers,
    authenticate,
    async authorizeOwner(headers) {
      const session = await authenticate(headers);
      if (!session) return "unauthenticated";
      return (await resolveOwnerSessionPermission(database.db, {
        userId: session.userId,
        sessionId: session.sessionId,
        now: new Date(),
      }))
        ? "authorized"
        : "forbidden";
    },
  };
  return runtime;
}
