import type { ServerEnv } from "@pawket/config";
import type { OidcSessionProvider } from "@pawket/identity/oidc-session";
import { createIdentityCommissionAssurancePort } from "@pawket/identity/commission-assurance-port";
import { createCommissionOrderMaintenanceService } from "@pawket/orders";
import { createCommissionPaymentIntentPort } from "@pawket/payments";
import type { EncryptionKeyring } from "@pawket/security";
import { createCommissionTrustPort } from "@pawket/trust";
import type { CommissionWorkerConfiguration } from "./worker-runtime.js";

export function createWorkerCommissionConfiguration(env: Pick<ServerEnv, "APP_REVISION" | "PII_LOOKUP_HMAC_KEY" | "COMMISSION_PAYMENTS_MODE" |
  "COMMISSION_SCAN_BATCH_SIZE" | "COMMISSION_SCAN_INTERVAL_MS">, keyring: EncryptionKeyring, identityProvider: OidcSessionProvider): CommissionWorkerConfiguration {
  return {
    paymentsMode: env.COMMISSION_PAYMENTS_MODE,
    batchSize: env.COMMISSION_SCAN_BATCH_SIZE, scanIntervalMs: env.COMMISSION_SCAN_INTERVAL_MS,
    createService(db) {
      return createCommissionOrderMaintenanceService({ db, applicationRevision: env.APP_REVISION,
        identity: createIdentityCommissionAssurancePort(identityProvider), trust: createCommissionTrustPort(),
        payments: createCommissionPaymentIntentPort({ keyring, lookupHmacKey: Buffer.from(env.PII_LOOKUP_HMAC_KEY, "base64"), paymentsMode: env.COMMISSION_PAYMENTS_MODE }),
      });
    },
  };
}
