import { randomUUID } from "node:crypto";

import { createCatalogCapabilityTransitionPort, createCreatorReviewHttpHandlers, createCreatorReviewService, createTipPolicyHttpHandlers, createOwnerTipPolicyAssurancePort } from "@pawket/admin";
import {
  createCatalogHttpHandlers,
  createCatalogMediaOwnershipPort,
  createCatalogService,
  createCreatorTipSettingsService,
  createCommissionPackageService,
  createPlatformTipPolicyService,
  createPublicCatalogQuery,
  type VisibilityReadPort,
} from "@pawket/catalog";
import { loadServerEnv, parseOidcEnv } from "@pawket/config";
import { createDatabase, type PawketDatabase, type PawketTransaction } from "@pawket/database";
import {
  createOidcAccountHttpHandlers,
  createOidcHttpHandlers,
  createOidcIdentityService,
  createOidcAssurancePort,
  createOidcPendingCommandRepository,
  createOidcCommandContext,
  readOpaqueCookie,
  type OidcSessionContext,
  createIdentityCreatorSeedPort,
  createIdentityCreatorTipAccountPort,
  createIdentityTipBuyerAccountPort,
  createIdentityTipAssurancePort,
  createIdentityCommissionAssurancePort,
  createIdentitySePayAssurancePort,
  createCreatorApplicationHttpHandlers,
  createCreatorApplicationService,
  getIdentityUserSummary,
  listUserSessions,
  recordSecurityThrottleAttempt,
  queueUserSecurityNotice,
  resolveSessionCookie,
  revokeOidcLocalSessions,
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
  createCommissionPaymentIntentPort, createCreatorCommissionPaymentService,
  createSePayConnectionService, createSePayInboxService, createSePayReconciliationService, createSePayReviewService,
  createSePayOAuthProvider, createSePayBudgetedProvider, createSePayHttpHandlers,
} from "@pawket/payments";
import { recordAuthAbuseControl } from "@pawket/observability";
import {
  createMediaHttpHandlers,
  createPublicMediaService,
  createS3ObjectStorage,
  type ObjectStoragePort,
} from "@pawket/public-media";
import { createEncryptionKeyring, createLookupHmac } from "@pawket/security";
import { recordTipOperation, setTipPaymentsEnabledMetric, recordSePayOperation, recordCommissionOperation, recordCommissionFileOperation } from "@pawket/observability";
import { createCommissionOrderService, createCommissionPolicyReadPort, createCommissionFileAccessPort } from "@pawket/orders";
import { createCommissionFileAttachmentPort, createCommissionFileService, createS3CommissionFileStorage, type CommissionFileStoragePort } from "@pawket/commission-files";
import { createTipAccessPort, createTipHttpHandlers, createTipService, createTipLifecyclePort, createCreatorTipHttpHandlers, createCreatorTipSettingsHttpHandlers } from "@pawket/tips";
import {
  createReportService,
  createTriageService,
  createTrustHttpHandlers,
  createCommissionTrustPort,
} from "@pawket/trust";

import { createMediaCommandHttpHandlers } from "./media-command-http.js";
import { createCommissionHttpHandlers } from "./commission-http.js";
import { createCommissionFileHttpHandlers } from "./commission-file-http.js";
import { createOidcCommandHttp } from "./oidc-command-http.js";
import { oidcCommand } from "./oidc-command-registry.js";

export type WebPlatformRuntime = {
  accountPortalUrl: string;
  oidc: ReturnType<typeof createOidcHttpHandlers>;
  pendingCommands: ReturnType<typeof createOidcCommandHttp>;
  handlers: ReturnType<typeof createOidcAccountHttpHandlers>;
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
  tipPolicyHandlers: ReturnType<typeof createTipPolicyHttpHandlers>;
  creatorTips: ReturnType<typeof createCreatorTipPaymentService>;
  sepayHandlers: ReturnType<typeof createSePayHttpHandlers>;
  commissionHandlers: ReturnType<typeof createCommissionHttpHandlers>;
  commissionFileHandlers: ReturnType<typeof createCommissionFileHttpHandlers>;
  commissions: ReturnType<typeof createCommissionOrderService>;
  commissionCatalog: ReturnType<typeof createCommissionPackageService>;
  mediaCommandHandlers: ReturnType<typeof createMediaCommandHttpHandlers>;
  mediaHandlers: ReturnType<typeof createMediaHttpHandlers>;
  media: ReturnType<typeof createPublicMediaService>;
  trustHandlers: ReturnType<typeof createTrustHttpHandlers>;
  reports: ReturnType<typeof createReportService>;
  triage: ReturnType<typeof createTriageService>;
  authenticate(headers: Headers, allowExpiredLease?: boolean): Promise<OidcSessionContext | null>;
  authorizeOwner(headers: Headers): Promise<"authorized" | "forbidden" | "unauthenticated">;
  authorizeCreator(headers: Headers): Promise<"authorized" | "forbidden" | "unauthenticated">;
};

let runtime: WebPlatformRuntime | undefined;

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

function unavailableCommissionFileStorage(): CommissionFileStoragePort {
  const unavailable = async (): Promise<never> => { throw new Error("Commission file storage unavailable"); };
  return { presignUpload: unavailable, presignDownload: unavailable, head: unavailable, open: unavailable, copyToClean: unavailable, deleteAllVersions: unavailable, headBucket: unavailable };
}

export function getPlatformRuntime(): WebPlatformRuntime {
  if (runtime) return runtime;

  const env = loadServerEnv();
  const oidcConfig = parseOidcEnv(process.env, env.APP_BASE_URL);
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
  // Legacy TOTP environment variable names configure freshness for either second factor.
  const commandFor: typeof oidcCommand = (payload) => {
    const command = oidcCommand(payload, {
    tip: { primaryFreshMs: env.TIP_RECENT_AUTH_SECONDS * 1000, mfaFreshMs: env.TIP_TOTP_AUTH_SECONDS * 1000 },
    commission: { primaryFreshMs: env.COMMISSION_RECENT_AUTH_SECONDS * 1000, mfaFreshMs: env.COMMISSION_TOTP_AUTH_SECONDS * 1000 },
    });
    return command && { ...command, policy: { ...command.policy,
      primaryFreshMs: Math.min(command.policy.primaryFreshMs ?? 900_000, env.AUTH_PRIMARY_STEP_UP_TTL_SECONDS * 1000),
      mfaFreshMs: Math.min(command.policy.mfaFreshMs ?? 300_000, env.AUTH_OWNER_TOTP_STEP_UP_TTL_SECONDS * 1000),
    } };
  };
  const pendingCommands = createOidcPendingCommandRepository({ db: database.db, keyring, provider: oidcConfig,
    fingerprintKey: lookupHmacKey, actionFor: (payload) => commandFor(payload)?.policy.actionClass ?? null,
    freshnessFor: (payload) => commandFor(payload)?.policy ?? {} });
  const commandContext = createOidcCommandContext({ provider: oidcConfig, commands: pendingCommands });
  const identity = createOidcIdentityService({ db: database.db, keyring, config: oidcConfig, applicationRevision: env.APP_REVISION,
    lifetimes: { user: { absolute: env.AUTH_USER_ABSOLUTE_TTL_SECONDS * 1000, idle: env.AUTH_USER_IDLE_TTL_SECONDS * 1000 },
      owner: { absolute: env.AUTH_OWNER_ABSOLUTE_TTL_SECONDS * 1000, idle: env.AUTH_OWNER_IDLE_TTL_SECONDS * 1000 } }, completeStepUp: pendingCommands.completeStepUp });
  const consumeStepUpProof = commandContext.consumeOwnerProof;
  const authorizeCommand = commandContext.authorize;
  const oidcAssurance = createOidcAssurancePort(oidcConfig);
  function resolveOwnerSessionPermission(db: PawketDatabase | PawketTransaction, actor: { userId: string; sessionId: string; now: Date }) {
    return db.transaction((tx) => oidcAssurance.authorizeOwner(tx, actor, actor.now));
  }
  const oidc = createOidcHttpHandlers({ baseURL: env.APP_BASE_URL, service: identity,
    stepUpIntent: (id, actor) => pendingCommands.intent({ id, actor, now: new Date() }),
    async throttle(request, action) {
      const network = (request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown-network").slice(0, 256);
      const result = await recordSecurityThrottleAttempt(database.db, { action, scope: "network", now: new Date(),
        subjectHmac: createLookupHmac({ value: network, context: "oidc-network", key: lookupHmacKey }),
        maximumAttempts: action === "oidc_logout" ? 120 : 60, windowMs: 60_000, blockMs: 60_000 });
      if (!result.allowed) recordAuthAbuseControl(action);
      return result.allowed;
    },
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
    authorizeCommand,
    catalogCapabilityTransition: createCatalogCapabilityTransitionPort(catalogService),
  });
  const receivingAccounts = createReceivingAccountService({
    db: database.db,
    keyring,
    lookupHmacKey,
    supportedBanks,
    authorizeCommand,
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

  async function authenticate(headers: Headers, allowExpiredLease = false) {
    const token = readOpaqueCookie(headers, resolveSessionCookie(env.APP_BASE_URL).name);
    return token ? identity.authenticate(token, allowExpiredLease) : null;
  }

  const handlers = createOidcAccountHttpHandlers({
    baseURL: env.APP_BASE_URL,
    accountPortalUrl: oidcConfig.accountPortalUrl,
    authenticate,
    getMe: (userId) => getIdentityUserSummary(database.db, userId),
    listSessions: (userId, now) => listUserSessions(database.db, { userId, now }),
    revokeSession: (input) =>
      database.db.transaction(async (tx) => {
        const revoked = await revokeOidcLocalSessions(tx, input, oidcConfig);
        if (revoked) {
          await queueUserSecurityNotice(tx, {
            id: randomUUID(),
            userId: input.userId,
            event: "session_revoked",
            keyring,
            now: input.now,
          });
        }
        return revoked > 0;
      }),
    revokeAllSessions: (input) =>
      database.db.transaction(async (tx) => {
        const revoked = await revokeOidcLocalSessions(tx, input, oidcConfig);
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
    issueOwnerStepUpProof: commandContext.issueOwnerProof,
    accounts: receivingAccounts,
    deposits: verificationDeposits,
  });
  const tipPolicy = createPlatformTipPolicyService({
    db: database.db, applicationRevision: env.APP_REVISION, commandFingerprintKey: lookupHmacKey,
    authorizeOwner: (tx, actor) => oidcAssurance.authorizeOwner(tx, actor, actor.now),
    requireOwnerStepUp: createOwnerTipPolicyAssurancePort({ provider: oidcConfig, authorizeCommand }).requireOwnerStepUp,
  });
  const tipSettings = createCreatorTipSettingsService({
    authorizeCommand,
    applicationRevision: env.APP_REVISION,
    db: database.db, visibility: publicCatalog, creatorAccount: createIdentityCreatorTipAccountPort(),
    receivingAccount: createTipReceivingAccountEligibilityPort({ keyring, lookupHmacKey, paymentsMode: env.TIP_PAYMENTS_MODE }),
    paymentsMode: env.TIP_PAYMENTS_MODE, publishingMode: env.CREATOR_PUBLISHING_MODE,
    platformPolicy: tipPolicy,
    recentAuthMs: env.TIP_RECENT_AUTH_SECONDS * 1000, commandFingerprintKey: lookupHmacKey,
  });
  const tipBuyerAccounts = createIdentityTipBuyerAccountPort();
  setTipPaymentsEnabledMetric(env.TIP_PAYMENTS_MODE !== "disabled");
  const tipCreation = createTipService({
    applicationRevision: env.APP_REVISION,
    onCommitted: (replayed) => recordTipOperation({ operation: "create", outcome: replayed ? "replayed" : "accepted" }),
    db: database.db, creatorEligibility: tipSettings, buyerAccounts: tipBuyerAccounts,
    payments: createTipPaymentIntentPort({ keyring, lookupHmacKey, paymentsMode: env.TIP_PAYMENTS_MODE, intentTtlMs: env.TIP_INTENT_TTL_SECONDS * 1000,
      guestReceiptTtlMs: env.TIP_GUEST_RECEIPT_TTL_SECONDS * 1000, openIpLimit: env.TIP_OPEN_IP_LIMIT, openCreatorLimit: env.TIP_OPEN_CREATOR_LIMIT,
      onQrOutcome: (outcome) => recordTipOperation({ operation: "qr", outcome }) }),
    paymentsMode: env.TIP_PAYMENTS_MODE, publishingMode: env.CREATOR_PUBLISHING_MODE,
    keyring, lookupHmacKey, idempotencyTtlMs: env.TIP_GUEST_RECEIPT_TTL_SECONDS * 1000,
  });
  async function tipThrottle(input: { action: string; subjectHmac: string; maximumAttempts: number; windowMs: number }) {
    return recordSecurityThrottleAttempt(database.db, { ...input, scope: input.action.endsWith("_creator") ? "account" : "network", now: new Date(), blockMs: input.windowMs });
  }
  const tipPolicyHandlers = createTipPolicyHttpHandlers({
    appBaseUrl: env.APP_BASE_URL, lookupHmacKey, paymentsMode: env.TIP_PAYMENTS_MODE,
    publishingMode: env.CREATOR_PUBLISHING_MODE, authenticate, service: tipPolicy,
    async authorizeOwner(headers) {
      const actor = await authenticate(headers);
      if (!actor) return "unauthenticated";
      return await resolveOwnerSessionPermission(database.db, { ...actor, now: new Date() }) ? "authorized" : "forbidden";
    },
    async throttle({ actorUserId, networkKeyHash, operation }) {
      const policy = { action: `owner_tip_policy_${operation}`, now: new Date(), windowMs: 60_000, blockMs: 60_000 };
      const [actor, network] = await Promise.all([
        recordSecurityThrottleAttempt(database.db, { ...policy, scope: "account",
          subjectHmac: createLookupHmac({ key: lookupHmacKey, context: "owner-tip-policy-actor", value: actorUserId }), maximumAttempts: operation === "read" ? 120 : 20 }),
        recordSecurityThrottleAttempt(database.db, { ...policy, scope: "network", subjectHmac: networkKeyHash, maximumAttempts: 120 }),
      ]);
      return actor.allowed && network.allowed;
    },
  });
  const tipReceipts = createTipReceiptService({
    applicationRevision: env.APP_REVISION,
    onClaimCommitted: (replayed) => recordTipOperation({ operation: "claim", outcome: replayed ? "replayed" : "recorded" }),
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
    resolveCreatorRateSubject: (handle) => database.db.transaction(async (tx) => (await tipSettings.getExistingTipEligibility(tx, handle))?.creatorUserId ?? null),
  });
  const creatorTips = createCreatorTipPaymentService({
    authorizeCommand,
    applicationRevision: env.APP_REVISION,
    onCommitted: (replayed) => recordTipOperation({ operation: "confirm", outcome: replayed ? "replayed" : "accepted" }),
    db: database.db, keyring, lookupHmacKey, paymentsMode: env.TIP_PAYMENTS_MODE, pageSize: env.TIP_QUEUE_PAGE_SIZE,
    recentAuthMs: env.TIP_RECENT_AUTH_SECONDS * 1000, mfaAuthMs: env.TIP_TOTP_AUTH_SECONDS * 1000,
    assurance: createIdentityTipAssurancePort(oidcConfig), tips: createTipLifecyclePort({ keyring }),
  });
  const commissionIdentity = createIdentityCommissionAssurancePort(oidcConfig);
  const commissionPolicy = createCommissionPolicyReadPort({ environment: env.APP_ENV });
  const commissionCommon = { db: database.db, applicationRevision: env.APP_REVISION, keyring, lookupHmacKey, authorizeCommand,
    intakeMode: env.COMMISSION_INTAKE_MODE, paymentsMode: env.COMMISSION_PAYMENTS_MODE };
  const commissionCatalog = createCommissionPackageService({ ...commissionCommon, identity: commissionIdentity, policy: commissionPolicy,
    visibility: publicCatalog, publishingMode: env.CREATOR_PUBLISHING_MODE,
    receivingAccount: createTipReceivingAccountEligibilityPort({ keyring, lookupHmacKey, paymentsMode: env.COMMISSION_PAYMENTS_MODE }) });
  const commissionFileStorage = env.COMMISSION_FILES_S3_ENDPOINT && env.COMMISSION_FILES_S3_REGION && env.COMMISSION_FILES_S3_ACCESS_KEY_ID && env.COMMISSION_FILES_S3_SECRET_ACCESS_KEY &&
    env.COMMISSION_FILES_QUARANTINE_BUCKET && env.COMMISSION_FILES_CLEAN_BUCKET
    ? createS3CommissionFileStorage({ endpoint: env.COMMISSION_FILES_S3_ENDPOINT, region: env.COMMISSION_FILES_S3_REGION, accessKeyId: env.COMMISSION_FILES_S3_ACCESS_KEY_ID,
        secretAccessKey: env.COMMISSION_FILES_S3_SECRET_ACCESS_KEY, quarantineBucket: env.COMMISSION_FILES_QUARANTINE_BUCKET, cleanBucket: env.COMMISSION_FILES_CLEAN_BUCKET,
        forcePathStyle: env.COMMISSION_FILES_S3_FORCE_PATH_STYLE })
    : unavailableCommissionFileStorage();
  const commissions = createCommissionOrderService({ ...commissionCommon, identity: commissionIdentity, trust: createCommissionTrustPort(),
    policy: commissionPolicy, catalog: commissionCatalog, payments: createCommissionPaymentIntentPort(commissionCommon),
    files: createCommissionFileAttachmentPort({ keyring, mode: env.COMMISSION_FILES_MODE }) });
  const commissionManual = createCreatorCommissionPaymentService({ ...commissionCommon, recentAuthMs: env.COMMISSION_RECENT_AUTH_SECONDS * 1000,
    mfaAuthMs: env.COMMISSION_TOTP_AUTH_SECONDS * 1000, assurance: commissionIdentity, commissions: commissions.paymentsLifecycle,
    onCommitted: (replayed) => recordCommissionOperation({ operation: "confirm", outcome: replayed ? "replayed" : "creator_manual" }) });
  const commissionHandlers = createCommissionHttpHandlers({ appBaseUrl: env.APP_BASE_URL, lookupHmacKey, intakeMode: env.COMMISSION_INTAKE_MODE,
    paymentsMode: env.COMMISSION_PAYMENTS_MODE, authenticate, orders: commissions, catalog: commissionCatalog, manual: commissionManual,
    onOperation: recordCommissionOperation,
    async throttle({ actorUserId, networkKeyHash, operation }) {
      const maximumAttempts = operation === "read" ? env.COMMISSION_READ_LIMIT : operation === "request" ? env.COMMISSION_REQUEST_LIMIT : env.COMMISSION_COMMAND_LIMIT;
      const policy = { action: `commission_${operation}`, now: new Date(), windowMs: env.COMMISSION_RATE_WINDOW_SECONDS * 1000, blockMs: env.COMMISSION_RATE_WINDOW_SECONDS * 1000, maximumAttempts };
      const results = await Promise.all([
        recordSecurityThrottleAttempt(database.db, { ...policy, scope: "network", subjectHmac: networkKeyHash }),
        ...(actorUserId ? [recordSecurityThrottleAttempt(database.db, { ...policy, scope: "account", subjectHmac: createLookupHmac({ key: lookupHmacKey, context: "commission-actor", value: actorUserId }) })] : []),
      ]);
      return results.every((result) => result.allowed);
    },
  });
  const commissionFiles = createCommissionFileService({ db: database.db, storage: commissionFileStorage, keyring, lookupHmacKey, mode: env.COMMISSION_FILES_MODE,
    sessions: commissionIdentity, orders: createCommissionFileAccessPort({ catalog: commissionCatalog }) });
  const commissionFileHandlers = createCommissionFileHttpHandlers({ appBaseUrl: env.APP_BASE_URL, lookupHmacKey, authenticate, files: commissionFiles,
    onOperation: recordCommissionFileOperation,
    async throttle({ actorUserId, networkKeyHash, operation }) {
      const maximumAttempts = operation === "read" ? env.COMMISSION_READ_LIMIT : operation === "file_grant" ? env.COMMISSION_FILES_GRANT_LIMIT : env.COMMISSION_COMMAND_LIMIT;
      const policy = { action: `commission_${operation}`, now: new Date(), windowMs: env.COMMISSION_RATE_WINDOW_SECONDS * 1000, blockMs: env.COMMISSION_RATE_WINDOW_SECONDS * 1000, maximumAttempts };
      const results = await Promise.all([
        recordSecurityThrottleAttempt(database.db, { ...policy, scope: "network", subjectHmac: networkKeyHash }),
        recordSecurityThrottleAttempt(database.db, { ...policy, scope: "account", subjectHmac: createLookupHmac({ key: lookupHmacKey, context: "commission-actor", value: actorUserId }) }),
      ]);
      return results.every((result) => result.allowed);
    },
  });
  const sepayEnvironment = env.SEPAY_ENVIRONMENT ?? (env.APP_ENV === "production" ? "live" : "test");
  const sharedSePayMode = env.TIP_PAYMENTS_MODE === "sepay_optional" || env.COMMISSION_PAYMENTS_MODE === "sepay_optional" ? "sepay_optional"
    : env.TIP_PAYMENTS_MODE === "manual_only" || env.COMMISSION_PAYMENTS_MODE === "manual_only" ? "manual_only" : "disabled";
  const sepayProvider = createSePayBudgetedProvider({ db: database.db, provider: createSePayOAuthProvider(sepayEnvironment) });
  const sepayAssurance = createIdentitySePayAssurancePort(oidcConfig);
  const sepayConnections = createSePayConnectionService({ db: database.db, keyring, lookupHmacKey, paymentsMode: sharedSePayMode,
    environment: sepayEnvironment, appBaseUrl: env.APP_BASE_URL, redirectUri: env.SEPAY_OAUTH_REDIRECT_URI ?? new URL("/api/v1/creator/tips/sepay/callback", env.APP_BASE_URL).href,
    applicationRevision: env.APP_REVISION, assurance: sepayAssurance, provider: sepayProvider, authorizeCommand });
  const sepayReconciliation = createSePayReconciliationService({ db: database.db, keyring, lookupHmacKey, paymentsMode: env.TIP_PAYMENTS_MODE,
    environment: sepayEnvironment, applicationRevision: env.APP_REVISION, workerIdentity: "web-reviewed-sepay", provider: sepayProvider, connections: sepayConnections,
    commissions: commissions.paymentsLifecycle, commissionPaymentsMode: env.COMMISSION_PAYMENTS_MODE,
    onCommissionConfirmed: (outcome) => recordCommissionOperation({ operation: "confirm", outcome }),
    assurance: sepayAssurance, tips: createTipLifecyclePort({ keyring }), maxAttempts: env.SEPAY_PROCESSING_MAX_ATTEMPTS, onOperation: recordSePayOperation, authorizeCommand });
  const sepayReviews = createSePayReviewService({ db: database.db, keyring, lookupHmacKey, paymentsMode: sharedSePayMode, environment: sepayEnvironment,
    applicationRevision: env.APP_REVISION, assurance: sepayAssurance, authorizeCommand, authorizeOwner: async (tx, actor) => Boolean(await resolveOwnerSessionPermission(tx, { ...actor, now: new Date() })) });
  const sepayHandlers = createSePayHttpHandlers({ appBaseUrl: env.APP_BASE_URL, paymentsMode: sharedSePayMode, ingressEnabled: env.SEPAY_INGRESS_MODE === "enabled",
    lookupHmacKey, authenticate, connections: sepayConnections, reviews: sepayReviews, reconciliation: sepayReconciliation, onOperation: recordSePayOperation,
    inbox: createSePayInboxService({ db: database.db, keyring, lookupHmacKey, enabled: env.SEPAY_INGRESS_MODE === "enabled", environment: sepayEnvironment }),
    async throttle({ actorUserId, networkKeyHash, operation }) {
      const policy = { action: `sepay_${operation}`, now: new Date(), windowMs: 60_000, blockMs: 60_000 };
      const [actor, network] = await Promise.all([
        recordSecurityThrottleAttempt(database.db, { ...policy, scope: "account", subjectHmac: createLookupHmac({ key: lookupHmacKey, context: "sepay-actor", value: actorUserId }), maximumAttempts: operation === "write" ? 20 : 120 }),
        recordSecurityThrottleAttempt(database.db, { ...policy, scope: "network", subjectHmac: networkKeyHash, maximumAttempts: 120 }),
      ]);
      return actor.allowed && network.allowed;
    },
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
    issueOwnerStepUpProof: commandContext.issueOwnerProof,
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
    issueOwnerStepUpProof: commandContext.issueOwnerProof,
    report: reportService,
    triage: triageService,
  });

  const commandHttp = createOidcCommandHttp({ db: database.db, baseUrl: env.APP_BASE_URL, commands: pendingCommands,
    context: commandContext, authenticate, commandFor, runtime: () => runtime! });
  runtime = {
    accountPortalUrl: oidcConfig.accountPortalUrl,
    oidc,
    pendingCommands: commandHttp,
    handlers,
    creatorHandlers,
    paymentsHandlers: commandHttp.wrap(paymentsHandlers),
    creatorReviewHandlers: commandHttp.wrap(creatorReviewHandlers),
    creatorReview,
    catalogHandlers,
    catalog: catalogService,
    publicCatalog,
    tipHandlers,
    publicTips: { getPublicOffering: tipCreation.getPublicOffering },
    tipSettings,
    creatorTipHandlers: commandHttp.wrap(creatorTipHandlers),
    creatorTipSettingsHandlers: commandHttp.wrap(creatorTipSettingsHandlers),
    tipPolicyHandlers: commandHttp.wrap(tipPolicyHandlers),
    creatorTips,
    sepayHandlers: commandHttp.wrap(sepayHandlers),
    commissionHandlers: commandHttp.wrap(commissionHandlers),
    commissionFileHandlers,
    commissions,
    commissionCatalog,
    mediaCommandHandlers,
    mediaHandlers,
    media: mediaService,
    trustHandlers: commandHttp.wrap(trustHandlers),
    reports: reportService,
    triage: triageService,
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
        where: (capabilities, { eq }) => eq(capabilities.userId, session.userId),
      });
      return capability ? "authorized" : "forbidden";
    },
  };
  return runtime;
}
