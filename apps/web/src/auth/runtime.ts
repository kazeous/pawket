import { createHash } from "node:crypto";

import { createCreatorReviewHttpHandlers, createCreatorReviewService, resolveOwnerSessionPermission } from "@pawket/admin";
import { loadServerEnv } from "@pawket/config";
import { createDatabase } from "@pawket/database";
import {
  createIdentityHttpHandlers,
  createCreatorApplicationHttpHandlers,
  createCreatorApplicationService,
  createIdentityService,
  createPawketAuth,
  createStepUpProof,
  consumeStepUpProof,
  getIdentityUserSummary,
  listUserSessions,
  recordSecurityThrottleAttempt,
  resolveSessionCookie,
  resolveAuthoritativeSessionById,
  revokeAllUserSessions,
  revokeUserSession,
} from "@pawket/identity";
import {
  createCreatorReceivingAccountReferenceValidator,
  createPaymentsHttpHandlers,
  createReceivingAccountService,
  createVerificationDepositService,
} from "@pawket/payments";
import { createEncryptionKeyring, createLookupHmac } from "@pawket/security";

type WebIdentityRuntime = {
  auth: ReturnType<typeof createPawketAuth>;
  handlers: ReturnType<typeof createIdentityHttpHandlers>;
  creatorHandlers: ReturnType<typeof createCreatorApplicationHttpHandlers>;
  paymentsHandlers: ReturnType<typeof createPaymentsHttpHandlers>;
  creatorReviewHandlers: ReturnType<typeof createCreatorReviewHttpHandlers>;
  creatorReview: ReturnType<typeof createCreatorReviewService>;
  authenticate(headers: Headers): Promise<{
    userId: string;
    sessionId: string;
    primaryAuthenticatedAt: Date;
  } | null>;
  authorizeOwner(headers: Headers): Promise<"authorized" | "forbidden" | "unauthenticated">;
  authorizeCreator(headers: Headers): Promise<"authorized" | "forbidden" | "unauthenticated">;
};

let runtime: WebIdentityRuntime | undefined;
const pwnedPasswordsMaximumResponseBytes = 256_000;

export function isSecurityEmailDeliveryAvailable(
  adapter: "disabled" | "local" | "smtp",
): boolean {
  return adapter !== "disabled";
}

export function createRuntimeCompromisedPasswordChecker(
  appEnv: "local" | "test" | "staging" | "production",
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): { isCompromised(password: string): Promise<boolean> } {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3_000;

  return {
    async isCompromised(password): Promise<boolean> {
      if (appEnv === "local" || appEnv === "test") return false;

      // SHA-1 is required only by the HIBP range protocol. Pawket never stores
      // this digest and sends only its first five characters.
      const digest = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
      const prefix = digest.slice(0, 5);
      const suffix = digest.slice(5);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
          cache: "no-store",
          headers: {
            accept: "text/plain",
            "add-padding": "true",
            "user-agent": "Pawket compromised-password checker",
          },
          signal: controller.signal,
        });
        const declaredLength = Number(response.headers.get("content-length") ?? 0);
        if (!response.ok || (Number.isFinite(declaredLength) && declaredLength > pwnedPasswordsMaximumResponseBytes)) {
          throw new Error("Compromised password source unavailable");
        }

        const body = await response.text();
        if (body.length > pwnedPasswordsMaximumResponseBytes) {
          throw new Error("Compromised password response too large");
        }

        let parsedRecord = false;
        for (const rawLine of body.split(/\r?\n/u)) {
          const line = rawLine.trim();
          if (!line) continue;
          const match = /^([A-F0-9]{35}):(\d+)$/u.exec(line);
          if (!match) throw new Error("Compromised password response malformed");
          const count = Number(match[2]);
          if (!Number.isSafeInteger(count) || count < 0) {
            throw new Error("Compromised password response malformed");
          }
          parsedRecord = true;
          if (match[1] === suffix && count > 0) return true;
        }

        if (!parsedRecord) throw new Error("Compromised password response empty");
        return false;
      } finally {
        clearTimeout(timeout);
      }
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
  const supportedBanks = {
    "000000": "Local test bank",
    "970415": "VietinBank",
    "970436": "Vietcombank",
    [env.OPERATING_BANK_BIN]:
      env.OPERATING_BANK_BIN === "000000"
        ? "Local test bank"
        : env.OPERATING_BANK_BIN === "970415"
          ? "VietinBank"
          : env.OPERATING_BANK_BIN === "970436"
            ? "Vietcombank"
            : "Configured operating bank",
  } as const;
  const auth = createPawketAuth({
    db: database.db,
    baseURL: env.APP_BASE_URL,
    trustedOrigins: env.AUTH_TRUSTED_ORIGINS,
    secrets: env.BETTER_AUTH_SECRETS,
    legacySecret: env.BETTER_AUTH_SECRETS[0]!.value,
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
  const creatorService = createCreatorApplicationService({
    db: database.db,
    keyring,
    commandFingerprintKey: lookupHmacKey,
    receivingAccountReferences: createCreatorReceivingAccountReferenceValidator({
      db: database.db,
    }),
  });
  const creatorReview = createCreatorReviewService({
    db: database.db,
    keyring,
    commandFingerprintKey: lookupHmacKey,
    consumeStepUpProof,
  });
  const receivingAccounts = createReceivingAccountService({
    db: database.db,
    keyring,
    lookupHmacKey,
    supportedBanks,
  });
  const verificationDeposits = createVerificationDepositService({
    db: database.db,
    keyring,
    lookupHmacKey,
    supportedBanks,
    depositAmountVnd: env.VERIFICATION_DEPOSIT_AMOUNT_VND,
    operatingAccount: {
      bankBin: env.OPERATING_BANK_BIN,
      bankName: supportedBanks[env.OPERATING_BANK_BIN] ?? "Configured operating bank",
      accountNumber: env.OPERATING_BANK_ACCOUNT_NUMBER,
      accountHolderLabel: env.OPERATING_BANK_ACCOUNT_NAME,
    },
    calendarVersion: env.VN_BUSINESS_CALENDAR_VERSION,
    consumeStepUpProof,
  });

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
  const paymentsHandlers = createPaymentsHttpHandlers({
    trustedOrigins: env.AUTH_TRUSTED_ORIGINS,
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
    issueOwnerStepUpProof: ({ userId, sessionId, actionClass, now }) =>
      createStepUpProof(database.db, {
        userId,
        sessionId,
        actionClass,
        assuranceMethod: "totp",
        now,
      }),
    accounts: receivingAccounts,
    deposits: verificationDeposits,
  });
  const creatorReviewHandlers = createCreatorReviewHttpHandlers({
    trustedOrigins: env.AUTH_TRUSTED_ORIGINS,
    authenticate,
    async authorizeOwner(headers) {
      const session = await authenticate(headers);
      if (!session) return "unauthenticated";
      return (await resolveOwnerSessionPermission(database.db, { userId: session.userId, sessionId: session.sessionId, now: new Date() })) ? "authorized" : "forbidden";
    },
    issueOwnerStepUpProof: ({ userId, sessionId, actionClass, now: issuedAt }) => createStepUpProof(database.db, { userId, sessionId, actionClass, assuranceMethod: "totp", now: issuedAt }),
    review: creatorReview,
  });

  runtime = {
    auth,
    handlers,
    creatorHandlers,
    paymentsHandlers,
    creatorReviewHandlers,
    creatorReview,
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
    async authorizeCreator(headers) {
      const session = await authenticate(headers);
      if (!session) return "unauthenticated";
      const capability = await database.db.query.identityCreatorCapabilities.findFirst({
        where: (capabilities, { and, eq }) =>
          and(eq(capabilities.userId, session.userId), eq(capabilities.state, "active")),
      });
      return capability ? "authorized" : "forbidden";
    },
  };
  return runtime;
}
