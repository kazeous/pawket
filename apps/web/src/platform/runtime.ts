import { createHash, randomUUID } from "node:crypto";

import { createCatalogCapabilityTransitionPort, createCreatorReviewHttpHandlers, createCreatorReviewService, resolveOwnerSessionPermission } from "@pawket/admin";
import {
  createCatalogHttpHandlers,
  createCatalogMediaOwnershipPort,
  createCatalogService,
  createCreatorTipSettingsService,
  createPublicCatalogQuery,
  type VisibilityReadPort,
} from "@pawket/catalog";
import { loadServerEnv } from "@pawket/config";
import { createDatabase } from "@pawket/database";
import {
  createIdentityHttpHandlers,
  createIdentityCreatorSeedPort,
  createIdentityCreatorTipAccountPort,
  createIdentityTipBuyerAccountPort,
  createIdentityTipAssurancePort,
  createCreatorApplicationHttpHandlers,
  createCreatorApplicationService,
  createIdentityService,
  createPawketAuth,
  createStepUpProof,
  consumeStepUpProof,
  getIdentityUserSummary,
  getTotpSecurityState,
  listUserSessions,
  recordSecurityThrottleAttempt,
  queueUserSecurityNotice,
  resolveSessionCookie,
  resolveAuthoritativeSessionById,
  revokeAllUserSessions,
  revokeUserSessionInTransaction,
} from "@pawket/identity";
import {
  createCreatorReceivingAccountReferenceValidator,
  createPaymentsHttpHandlers,
  createReceivingAccountService,
  createVerificationDepositService,
  createTipPaymentIntentPort,
  createTipReceiptService,
  createTipReceivingAccountEligibilityPort,
  createCreatorTipPaymentService,
} from "@pawket/payments";
import { recordAuthAbuseControl } from "@pawket/observability";
import {
  createMediaHttpHandlers,
  createPublicMediaService,
  createS3ObjectStorage,
  type ObjectStoragePort,
} from "@pawket/public-media";
import { createEncryptionKeyring, createLookupHmac } from "@pawket/security";
import { createTipAccessPort, createTipHttpHandlers, createTipService, createTipLifecyclePort, createCreatorTipHttpHandlers, createCreatorTipSettingsHttpHandlers } from "@pawket/tips";
import {
  createReportService,
  createTriageService,
  createTrustHttpHandlers,
} from "@pawket/trust";

import { createMediaCommandHttpHandlers } from "./media-command-http.js";

type WebPlatformRuntime = {
  auth: ReturnType<typeof createPawketAuth>;
  handlers: ReturnType<typeof createIdentityHttpHandlers>;
  creatorHandlers: ReturnType<typeof createCreatorApplicationHttpHandlers>;
  paymentsHandlers: ReturnType<typeof createPaymentsHttpHandlers>;
  creatorReviewHandlers: ReturnType<typeof createCreatorReviewHttpHandlers>;
  creatorReview: ReturnType<typeof createCreatorReviewService>;
  catalogHandlers: ReturnType<typeof createCatalogHttpHandlers>;
  catalog: ReturnType<typeof createCatalogService>;
  publicCatalog: ReturnType<typeof createPublicCatalogQuery>;
  tipHandlers: ReturnType<typeof createTipHttpHandlers>;
  publicTips: Pick<ReturnType<typeof createTipService>, "getPublicOffering">;
  tipSettings: ReturnType<typeof createCreatorTipSettingsService>;
  creatorTipHandlers: ReturnType<typeof createCreatorTipHttpHandlers>;
  creatorTipSettingsHandlers: ReturnType<typeof createCreatorTipSettingsHttpHandlers>;
  creatorTips: ReturnType<typeof createCreatorTipPaymentService>;
  mediaCommandHandlers: ReturnType<typeof createMediaCommandHttpHandlers>;
  mediaHandlers: ReturnType<typeof createMediaHttpHandlers>;
  media: ReturnType<typeof createPublicMediaService>;
  trustHandlers: ReturnType<typeof createTrustHttpHandlers>;
  reports: ReturnType<typeof createReportService>;
  triage: ReturnType<typeof createTriageService>;
  authenticate(headers: Headers): Promise<{
    userId: string;
    sessionId: string;
    primaryAuthenticatedAt: Date;
  } | null>;
  getTotpSecurityState(userId: string): Promise<{ enabled: boolean } | null>;
  authorizeOwner(headers: Headers): Promise<"authorized" | "forbidden" | "unauthenticated">;
  authorizeCreator(headers: Headers): Promise<"authorized" | "forbidden" | "unauthenticated">;
};

let runtime: WebPlatformRuntime | undefined;
const pwnedPasswordsMaximumResponseBytes = 256_000;

function unavailableMediaStorage(): ObjectStoragePort {
  const unavailable = async (): Promise<never> => { throw new Error("Public media storage unavailable"); };
  return {
    presignPut: unavailable,
    headBucket: unavailable,
    headObject: unavailable,
    listObjectVersions: unavailable,
    getObject: unavailable,
    putObject: unavailable,
    deleteObject: unavailable,
  };
}

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

export function getPlatformRuntime(): WebPlatformRuntime {
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
    acceleration: {
      async observe(input) {
        if (input.outcome === "blocked") recordAuthAbuseControl(input.action);
      },
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
  const identityCreatorSeeds = createIdentityCreatorSeedPort();
  const configuredStorage = env.PUBLIC_MEDIA_S3_ENDPOINT &&
    env.PUBLIC_MEDIA_S3_REGION &&
    env.PUBLIC_MEDIA_S3_ACCESS_KEY_ID &&
    env.PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY &&
    env.PUBLIC_MEDIA_QUARANTINE_BUCKET &&
    env.PUBLIC_MEDIA_DERIVATIVE_BUCKET
    ? createS3ObjectStorage({
        endpoint: env.PUBLIC_MEDIA_S3_ENDPOINT,
        region: env.PUBLIC_MEDIA_S3_REGION,
        accessKeyId: env.PUBLIC_MEDIA_S3_ACCESS_KEY_ID,
        secretAccessKey: env.PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY,
        quarantineBucket: env.PUBLIC_MEDIA_QUARANTINE_BUCKET,
        derivativeBucket: env.PUBLIC_MEDIA_DERIVATIVE_BUCKET,
        forcePathStyle: env.PUBLIC_MEDIA_S3_FORCE_PATH_STYLE,
      })
    : unavailableMediaStorage();
  const trustServices: { triage?: ReturnType<typeof createTriageService> } = {};
  const visibilityReadPort: VisibilityReadPort = {
    readHolds(db, pageId, revisionId, showcaseIds) {
      if (!trustServices.triage) throw new Error("Trust visibility unavailable");
      return trustServices.triage.visibilityReadPort.readHolds(db, pageId, revisionId, showcaseIds);
    },
    readHoldsBatch(db, requests) {
      if (!trustServices.triage) throw new Error("Trust visibility unavailable");
      return trustServices.triage.visibilityReadPort.readHoldsBatch(db, requests);
    },
  };
  const mediaService = createPublicMediaService({
    db: database.db,
    storage: configuredStorage,
    creator: {
      async getCreatorCapability(db, userId) {
        const seed = await identityCreatorSeeds.getCreatorSeed(db, userId);
        return seed ? { userId, state: seed.capabilityState } : null;
      },
    },
    catalog: createCatalogMediaOwnershipPort(),
    publishingMode: env.CREATOR_PUBLISHING_MODE,
    commandFingerprintKey: lookupHmacKey,
  });
  const catalogService = createCatalogService({
    db: database.db,
    creatorSeeds: identityCreatorSeeds,
    mediaCatalog: mediaService,
    visibility: visibilityReadPort,
    publishingMode: env.CREATOR_PUBLISHING_MODE,
    commandFingerprintKey: lookupHmacKey,
  });
  const publicCatalog = createPublicCatalogQuery({
    db: database.db,
    creatorSeeds: identityCreatorSeeds,
    mediaCatalog: mediaService,
    visibility: visibilityReadPort,
    publishingMode: env.CREATOR_PUBLISHING_MODE,
  });
  const reportService = createReportService({
    db: database.db,
    catalogModeration: publicCatalog,
    lookupHmacKey,
  });
  const triageService = createTriageService({
    db: database.db,
    catalogModeration: publicCatalog,
    commandFingerprintKey: lookupHmacKey,
    consumeStepUpProof,
  });
  trustServices.triage = triageService;
  const creatorReview = createCreatorReviewService({
    db: database.db,
    keyring,
    commandFingerprintKey: lookupHmacKey,
    consumeStepUpProof,
    catalogCapabilityTransition: createCatalogCapabilityTransitionPort(catalogService),
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
    revokeSession: (input) =>
      database.db.transaction(async (tx) => {
        const revoked = await revokeUserSessionInTransaction(tx, input);
        if (revoked) {
          await queueUserSecurityNotice(tx, {
            id: randomUUID(),
            userId: input.userId,
            event: "session_revoked",
            keyring,
            now: input.now,
          });
        }
        return revoked;
      }),
    revokeAllSessions: (input) =>
      database.db.transaction(async (tx) => {
        const revoked = await revokeAllUserSessions(tx, input);
        if (revoked > 0) {
          await queueUserSecurityNotice(tx, {
            id: randomUUID(),
            userId: input.userId,
            event: "sessions_revoked",
            keyring,
            now: input.now,
          });
        }
        return revoked;
      }),
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
  const tipSettings = createCreatorTipSettingsService({
    db: database.db, visibility: publicCatalog, creatorAccount: createIdentityCreatorTipAccountPort(),
    receivingAccount: createTipReceivingAccountEligibilityPort({ keyring, lookupHmacKey }),
    paymentsMode: env.TIP_PAYMENTS_MODE, publishingMode: env.CREATOR_PUBLISHING_MODE,
    amountPolicy: { minimumVnd: env.TIP_AMOUNT_MIN_VND, maximumVnd: env.TIP_AMOUNT_MAX_VND, allowedPresetsVnd: env.TIP_SUGGESTED_PRESETS_VND },
    recentAuthMs: env.TIP_RECENT_AUTH_SECONDS * 1000, commandFingerprintKey: lookupHmacKey,
  });
  const tipBuyerAccounts = createIdentityTipBuyerAccountPort();
  const tipCreation = createTipService({
    db: database.db, creatorEligibility: tipSettings, buyerAccounts: tipBuyerAccounts,
    payments: createTipPaymentIntentPort({ keyring, lookupHmacKey, intentTtlMs: env.TIP_INTENT_TTL_SECONDS * 1000,
      guestReceiptTtlMs: env.TIP_GUEST_RECEIPT_TTL_SECONDS * 1000, openIpLimit: env.TIP_OPEN_IP_LIMIT, openCreatorLimit: env.TIP_OPEN_CREATOR_LIMIT }),
    paymentsMode: env.TIP_PAYMENTS_MODE, publishingMode: env.CREATOR_PUBLISHING_MODE,
    keyring, lookupHmacKey, idempotencyTtlMs: env.TIP_GUEST_RECEIPT_TTL_SECONDS * 1000,
  });
  async function tipThrottle(input: { action: string; subjectHmac: string; maximumAttempts: number; windowMs: number }) {
    return recordSecurityThrottleAttempt(database.db, { ...input, scope: input.action.endsWith("_creator") ? "account" : "network", now: new Date(), blockMs: input.windowMs });
  }
  const tipReceipts = createTipReceiptService({
    db: database.db, paymentsMode: env.TIP_PAYMENTS_MODE, keyring, lookupHmacKey, tips: createTipAccessPort(), buyerAccounts: tipBuyerAccounts, creatorEligibility: tipSettings,
    async claimRateLimit(creatorUserId) {
      return (await tipThrottle({ action: "tip_claim_creator", subjectHmac: createLookupHmac({ key: lookupHmacKey, context: "tip-creator-rate", value: creatorUserId }),
        maximumAttempts: env.TIP_CREATE_CREATOR_LIMIT, windowMs: env.TIP_RATE_WINDOW_SECONDS * 1000 })).allowed;
    },
  });
  const tipHandlers = createTipHttpHandlers({
    appBaseUrl: env.APP_BASE_URL, paymentsMode: env.TIP_PAYMENTS_MODE, publishingMode: env.CREATOR_PUBLISHING_MODE, lookupHmacKey,
    guestContextTtlMs: env.TIP_GUEST_RECEIPT_TTL_SECONDS * 1000, rateWindowMs: env.TIP_RATE_WINDOW_SECONDS * 1000,
    createIpLimit: env.TIP_CREATE_IP_LIMIT, createCreatorLimit: env.TIP_CREATE_CREATOR_LIMIT, receiptLimit: env.TIP_RECEIPT_REQUEST_LIMIT,
    authenticate, creation: tipCreation, receipts: tipReceipts, throttle: tipThrottle,
    resolveCreatorRateSubject: (handle) => database.db.transaction(async (tx) => (await tipSettings.getTipEligibility(tx, handle))?.creatorUserId ?? null),
  });
  const creatorTips = createCreatorTipPaymentService({
    db: database.db, keyring, lookupHmacKey, paymentsMode: env.TIP_PAYMENTS_MODE, pageSize: env.TIP_QUEUE_PAGE_SIZE,
    recentAuthMs: env.TIP_RECENT_AUTH_SECONDS * 1000, totpAuthMs: env.TIP_TOTP_AUTH_SECONDS * 1000,
    assurance: createIdentityTipAssurancePort(), tips: createTipLifecyclePort({ keyring }),
  });
  const creatorTipHandlers = createCreatorTipHttpHandlers({
    appBaseUrl: env.APP_BASE_URL, paymentsMode: env.TIP_PAYMENTS_MODE, lookupHmacKey, authenticate, service: creatorTips,
    async throttle({ actorUserId, networkKeyHash, operation }) {
      const policy = { action: `tip_creator_${operation}`, now: new Date(), windowMs: env.TIP_RATE_WINDOW_SECONDS * 1000, blockMs: env.TIP_RATE_WINDOW_SECONDS * 1000 };
      const [actor, network] = await Promise.all([
        recordSecurityThrottleAttempt(database.db, { ...policy, scope: "account", subjectHmac: createLookupHmac({ key: lookupHmacKey, context: "tip-creator-command-rate", value: actorUserId }),
          maximumAttempts: operation === "queue" ? env.TIP_RECEIPT_REQUEST_LIMIT : env.TIP_CREATE_CREATOR_LIMIT }),
        recordSecurityThrottleAttempt(database.db, { ...policy, scope: "network", subjectHmac: networkKeyHash, maximumAttempts: env.TIP_RECEIPT_REQUEST_LIMIT }),
      ]);
      return actor.allowed && network.allowed;
    },
  });
  const creatorTipSettingsHandlers = createCreatorTipSettingsHttpHandlers({
    appBaseUrl: env.APP_BASE_URL, paymentsMode: env.TIP_PAYMENTS_MODE, publishingMode: env.CREATOR_PUBLISHING_MODE, lookupHmacKey, authenticate, service: tipSettings,
    async throttle({ actorUserId, networkKeyHash, operation }) {
      const policy = { action: `tip_settings_${operation}`, now: new Date(), windowMs: env.TIP_RATE_WINDOW_SECONDS * 1000, blockMs: env.TIP_RATE_WINDOW_SECONDS * 1000 };
      const [actor, network] = await Promise.all([
        recordSecurityThrottleAttempt(database.db, { ...policy, scope: "account", subjectHmac: createLookupHmac({ key: lookupHmacKey, context: "tip-settings-command-rate", value: actorUserId }),
          maximumAttempts: operation === "read" ? env.TIP_RECEIPT_REQUEST_LIMIT : env.TIP_CREATE_CREATOR_LIMIT }),
        recordSecurityThrottleAttempt(database.db, { ...policy, scope: "network", subjectHmac: networkKeyHash, maximumAttempts: env.TIP_RECEIPT_REQUEST_LIMIT }),
      ]);
      return actor.allowed && network.allowed;
    },
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
  const catalogHandlers = createCatalogHttpHandlers({
    trustedOrigins: env.AUTH_TRUSTED_ORIGINS,
    authenticate,
    service: catalogService,
    publishingMode: env.CREATOR_PUBLISHING_MODE,
  });
  const mediaCommandHandlers = createMediaCommandHttpHandlers({
    appBaseUrl: env.APP_BASE_URL,
    authenticate,
    media: mediaService,
  });
  const mediaHandlers = createMediaHttpHandlers({
    db: database.db,
    media: mediaService,
    storage: configuredStorage,
    catalog: publicCatalog,
    authenticate,
  });
  const trustHandlers = createTrustHttpHandlers({
    appBaseUrl: env.APP_BASE_URL,
    lookupHmacKey,
    optionalAuthoritativeSession: authenticate,
    async authorizeOwner(headers) {
      const session = await authenticate(headers);
      if (!session) return "unauthenticated";
      return (await resolveOwnerSessionPermission(database.db, {
        userId: session.userId,
        sessionId: session.sessionId,
        now: new Date(),
      })) ? "authorized" : "forbidden";
    },
    issueOwnerStepUpProof: ({ userId, sessionId, actionClass, now: issuedAt }) =>
      createStepUpProof(database.db, {
        userId,
        sessionId,
        actionClass,
        assuranceMethod: "totp",
        now: issuedAt,
      }),
    report: reportService,
    triage: triageService,
  });

  runtime = {
    auth,
    handlers,
    creatorHandlers,
    paymentsHandlers,
    creatorReviewHandlers,
    creatorReview,
    catalogHandlers,
    catalog: catalogService,
    publicCatalog,
    tipHandlers,
    publicTips: { getPublicOffering: tipCreation.getPublicOffering },
    tipSettings,
    creatorTipHandlers,
    creatorTipSettingsHandlers,
    creatorTips,
    mediaCommandHandlers,
    mediaHandlers,
    media: mediaService,
    trustHandlers,
    reports: reportService,
    triage: triageService,
    authenticate,
    getTotpSecurityState: (userId) => getTotpSecurityState(database.db, userId),
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
        where: (capabilities, { eq }) => eq(capabilities.userId, session.userId),
      });
      return capability ? "authorized" : "forbidden";
    },
  };
  return runtime;
}
