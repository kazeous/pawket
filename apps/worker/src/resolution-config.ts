import { randomUUID } from "node:crypto";
import type { ServerEnv } from "@pawket/config";
import { createCommissionResolutionOrderPort } from "@pawket/orders";
import { createCommissionPaymentFactsPort, createCommissionRefundPort } from "@pawket/payments";
import { createResolutionMaintenance } from "@pawket/resolutions";
import type { EncryptionKeyring } from "@pawket/security";
import { createTrustCasePort } from "@pawket/trust";
import type { ResolutionWorkerConfiguration } from "./worker-runtime.js";

export function createWorkerResolutionConfiguration(env: Pick<ServerEnv, "APP_REVISION" | "COMMISSION_RESOLUTION_MODE" | "VN_BUSINESS_CALENDAR_VERSION">,
  keyring: EncryptionKeyring): ResolutionWorkerConfiguration {
  return { mode: env.COMMISSION_RESOLUTION_MODE, createService(db) {
    return createResolutionMaintenance({ db, orders: createCommissionResolutionOrderPort({ applicationRevision: env.APP_REVISION, newId: randomUUID }),
      refunds: createCommissionRefundPort({ keyring, calendarVersion: env.VN_BUSINESS_CALENDAR_VERSION }),
      payments: createCommissionPaymentFactsPort(), cases: createTrustCasePort() });
  } };
}
