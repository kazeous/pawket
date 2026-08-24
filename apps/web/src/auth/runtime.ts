import { loadServerEnv } from "@pawket/config";
import { createDatabase } from "@pawket/database";
import {
  createIdentityHttpHandlers,
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
};

let runtime: WebIdentityRuntime | undefined;

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
  const emailDeliveryAvailable = env.SECURITY_EMAIL_ADAPTER === "local";
  const auth = createPawketAuth({
    db: database.db,
    baseURL: env.APP_BASE_URL,
    trustedOrigins: env.AUTH_TRUSTED_ORIGINS,
    secret: env.BETTER_AUTH_SECRETS[0]!,
    lookupHmacKey,
  });
  const service = createIdentityService({
    db: database.db,
    keyring,
    lookupHmacKey,
    compromisedPasswordChecker: {
      async isCompromised(): Promise<boolean> {
        if (!emailDeliveryAvailable) {
          throw new Error("Compromised password check is unavailable");
        }
        return false;
      },
    },
  });

  const handlers = createIdentityHttpHandlers({
    trustedOrigins: env.AUTH_TRUSTED_ORIGINS,
    emailDeliveryAvailable,
    sessionCookie: resolveSessionCookie(env.APP_BASE_URL),
    service,
    async authenticate(headers) {
      const resolved = (await auth.api.getSession({ headers })) as
        | { session: { id: string }; user: { id: string } }
        | null;
      if (!resolved) return null;
      return resolveAuthoritativeSessionById(database.db, {
        sessionId: resolved.session.id,
        userId: resolved.user.id,
        now: new Date(),
      });
    },
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

  runtime = { auth, handlers };
  return runtime;
}
