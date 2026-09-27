import type { ServerEnv } from "@pawket/config";
import { createIdentitySePayAssurancePort } from "@pawket/identity/sepay-assurance-port";
import { createIdentityCommissionAssurancePort } from "@pawket/identity/commission-assurance-port";
import { createCommissionPaymentLifecyclePort } from "@pawket/orders";
import { createCommissionTrustPort } from "@pawket/trust";
import { recordSePayOperation, recordCommissionOperation } from "@pawket/observability";
import { createSePayBudgetedProvider, createSePayConnectionService, createSePayOAuthProvider, createSePayReconciliationService } from "@pawket/payments";
import type { EncryptionKeyring } from "@pawket/security";
import { createTipLifecyclePort } from "@pawket/tips";
import type { SePayWorkerConfiguration } from "./worker-runtime.js";

type Env = Pick<ServerEnv, "TIP_PAYMENTS_MODE" | "COMMISSION_PAYMENTS_MODE" | "SEPAY_ENVIRONMENT" | "SEPAY_PROCESSING_BATCH_SIZE" | "SEPAY_PROCESSING_SCAN_INTERVAL_MS" |
  "SEPAY_PROCESSING_MAX_ATTEMPTS" | "APP_BASE_URL" | "APP_REVISION" | "SEPAY_OAUTH_REDIRECT_URI" | "PII_LOOKUP_HMAC_KEY">;

/** Only the gated production adapter is constructible here; fixtures are test injection. */
export function createWorkerSePayConfiguration(env: Env, keyring: EncryptionKeyring): SePayWorkerConfiguration | undefined {
  if (!env.SEPAY_ENVIRONMENT) return undefined;
  const environment = env.SEPAY_ENVIRONMENT;
  const provider = createSePayOAuthProvider(environment);
  return {
    environment,
    mode: env.TIP_PAYMENTS_MODE,
    commissionMode: env.COMMISSION_PAYMENTS_MODE,
    providerContractReady: Object.values(provider.capabilities).every(Boolean),
    batchSize: env.SEPAY_PROCESSING_BATCH_SIZE,
    scanIntervalMs: env.SEPAY_PROCESSING_SCAN_INTERVAL_MS,
    createService(db, workerId) {
      const common = { db, keyring, lookupHmacKey: Buffer.from(env.PII_LOOKUP_HMAC_KEY, "base64"), paymentsMode: env.TIP_PAYMENTS_MODE,
        environment, applicationRevision: env.APP_REVISION, assurance: createIdentitySePayAssurancePort(), provider: createSePayBudgetedProvider({ db, provider }) };
      const connections = createSePayConnectionService({ ...common, appBaseUrl: env.APP_BASE_URL,
        paymentsMode: env.COMMISSION_PAYMENTS_MODE === "sepay_optional" ? "sepay_optional" : env.TIP_PAYMENTS_MODE,
        redirectUri: env.SEPAY_OAUTH_REDIRECT_URI ?? new URL("/api/v1/creator/tips/sepay/callback", env.APP_BASE_URL).href });
      const identity = createIdentityCommissionAssurancePort(); const trust = createCommissionTrustPort();
      const commissions = createCommissionPaymentLifecyclePort({ eligibility: { lockSettlementParticipants: async (tx, command) =>
        await identity.lockSettlementParticipants(tx, command) && await trust.lockCommissionPage(tx, command.creatorUserId) } });
      return createSePayReconciliationService({ ...common, connections, workerIdentity: workerId, tips: createTipLifecyclePort({ keyring }),
        commissions, commissionPaymentsMode: env.COMMISSION_PAYMENTS_MODE,
        onCommissionConfirmed: (outcome) => recordCommissionOperation({ operation: "confirm", outcome }),
        maxAttempts: env.SEPAY_PROCESSING_MAX_ATTEMPTS, onOperation: recordSePayOperation });
    },
  };
}
