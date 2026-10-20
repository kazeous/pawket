import { randomUUID } from "node:crypto";
import type { ServerEnv } from "@pawket/config";
import { findOperationalEmailUser, type PawketDatabase } from "@pawket/database";
import { queueSecurityEmailHandoff, recordSecurityEmailAttentionRequired } from "@pawket/identity/security-email-handoff";
import { createNotificationMaterializer, type NotificationEmailPort } from "@pawket/notifications";
import { recordNotificationOperation, recordSecurityEmailMetrics } from "@pawket/observability";
import type { EncryptionKeyring } from "@pawket/security";
import type { NotificationWorkerConfiguration, NotificationWorkerMaterializer } from "./worker-runtime.js";

type EmailOutcome = "queued" | "attention_required";

/** The worker's notification email port: purpose `notification`, no source outbox event id (P7), templateData limited to four fields. */
export function createNotificationEmailPort(input: { keyring: EncryptionKeyring; id?: () => string; onQueued?: (outcome: EmailOutcome) => void }): NotificationEmailPort {
  const id = input.id ?? randomUUID;
  return {
    async queue(tx, notice) {
      // Account notices are in-app only; the worker refuses a notification email in that category.
      if (notice.category === "account") throw new Error("Invalid notification email");
      const user = await findOperationalEmailUser(tx, notice.userId); if (!user) throw new Error("Invalid notification email");
      const templateData = { kind: notice.kind, variant: notice.variant ?? "", category: notice.category, linkPath: notice.linkPath };
      const handoffId = id(); const shared = { id: handoffId, userId: notice.userId, purpose: "notification" as const, templateData, now: notice.at };
      const outcome: EmailOutcome = user.emailVerified ? "queued" : "attention_required";
      if (user.emailVerified) await queueSecurityEmailHandoff(tx, { ...shared, destination: user.email, keyring: input.keyring });
      else await recordSecurityEmailAttentionRequired(tx, { ...shared, failureCode: "no_verified_destination" });
      input.onQueued?.(outcome);
      return { handoffId, outcome };
    },
  };
}

/** One materializer per event so email metrics are recorded only after that event's transaction commits. */
export function createWorkerNotificationMaterializer(input: { db: PawketDatabase; keyring: EncryptionKeyring; now?: () => Date }): NotificationWorkerMaterializer {
  return {
    async materialize(event) {
      const outcomes: EmailOutcome[] = [];
      const email = createNotificationEmailPort({ keyring: input.keyring, onQueued: (outcome) => outcomes.push(outcome) });
      const result = await createNotificationMaterializer({ db: input.db, mode: "enabled", email, now: input.now }).materialize(event);
      for (const outcome of outcomes) {
        recordSecurityEmailMetrics({ purpose: "notification", outcome });
        recordNotificationOperation({ operation: "email", outcome });
      }
      return result;
    },
  };
}

export function createWorkerNotificationConfiguration(env: Pick<ServerEnv, "NOTIFICATIONS_MODE">, keyring: EncryptionKeyring): NotificationWorkerConfiguration {
  return { mode: env.NOTIFICATIONS_MODE, createMaterializer: (db) => createWorkerNotificationMaterializer({ db, keyring }) };
}
