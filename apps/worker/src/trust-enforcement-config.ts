import { randomUUID } from "node:crypto";
import type { ServerEnv } from "@pawket/config";
import { createEnforcementNoticePort, createIdentityEnforcementPort } from "@pawket/identity";
import { canonicalizeEmailAddress } from "@pawket/identity/email-address";
import { createCommissionResolutionOrderPort, lockCommissionCreator } from "@pawket/orders";
import { createCommissionPaymentFactsPort, createCommissionRefundPort } from "@pawket/payments";
import { createRemovalFreezePort } from "@pawket/resolutions";
import type { EncryptionKeyring } from "@pawket/security";
import { createEnforcementMaintenance, createHelpLinkService, createPenaltyService, createTrustCasePort, trustFail } from "@pawket/trust";
import type { TrustEnforcementWorkerConfiguration } from "./worker-runtime.js";

export function createWorkerTrustEnforcementConfiguration(env: Pick<ServerEnv,
  "APP_REVISION" | "TRUST_ENFORCEMENT_MODE" | "COMMISSION_RESOLUTION_MODE" | "VN_BUSINESS_CALENDAR_VERSION" | "PII_LOOKUP_HMAC_KEY">,
keyring: EncryptionKeyring): TrustEnforcementWorkerConfiguration {
  return { mode: env.TRUST_ENFORCEMENT_MODE, createService(db, onPenaltyFailure) {
    const lookupHmacKey = Buffer.from(env.PII_LOOKUP_HMAC_KEY, "base64");
    const notices = createEnforcementNoticePort({ keyring });
    const helpLinks = createHelpLinkService({ db, mode: env.TRUST_ENFORCEMENT_MODE, lookupHmacKey, notices,
      canonicalizeEmail: (raw) => { try { return canonicalizeEmailAddress(raw).canonical; } catch { return null; } },
      logger: { error: () => undefined } });
    const identity = createIdentityEnforcementPort({ async clearPublishedHeadForSuspension() {
      // Expiry restores standing; an actorless worker cannot initiate a publication suspension.
      // Match the web runtime's refusal when the catalog transition has no owner actor.
      return trustFail("dependency_unavailable");
    } });
    const penalties = createPenaltyService({ db, mode: env.TRUST_ENFORCEMENT_MODE, keyring, lookupHmacKey,
      applicationRevision: env.APP_REVISION, consumeStepUpProof: async () => false,
      fence: { lockCreatorFence: lockCommissionCreator }, identity,
      freeze: createRemovalFreezePort({ mode: env.COMMISSION_RESOLUTION_MODE,
        orders: createCommissionResolutionOrderPort({ applicationRevision: env.APP_REVISION, newId: randomUUID }),
        refunds: createCommissionRefundPort({ keyring, calendarVersion: env.VN_BUSINESS_CALENDAR_VERSION }),
        payments: createCommissionPaymentFactsPort(), cases: createTrustCasePort() }),
      // Neither policy publication nor help-link issuance occurs on the expiry path.
      policies: { readCurrentIds: async () => trustFail("dependency_unavailable") }, helpLinks, notices });
    return createEnforcementMaintenance({ db, penalties, mode: env.TRUST_ENFORCEMENT_MODE, onPenaltyFailure });
  } };
}
