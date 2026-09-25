import { randomUUID } from "node:crypto";
import {
  appendAdminAuditEvent, beginIdempotentCommand, completeIdempotentCommand, paymentsReceivingAccountOnboarding,
  paymentsSepayConnections, paymentsSepayDecisions, paymentsSepayInbox, paymentsSepayProcessing,
  type PawketDatabase, type PawketTransaction,
} from "@pawket/database";
import type { EncryptionKeyring } from "@pawket/security";
import { and, count, desc, eq, inArray, lt, or } from "drizzle-orm";
import { parseAuthenticatedSePayWebhook } from "./sepay-webhook.js";
import { createSePayCryptography, requireSePayAssurance, sepayBoundary, sepayFail, sepayUuid, validateSePayActor, validateSePayCommand, type SePayActor, type SePayAssurancePort } from "./sepay-service-support.js";

export type SePayReviewItem = Readonly<{
  id: string; connectionId: string; version: number; status: string; reason: string | null;
  amountVnd: number | null; reference: string | null; receivedAt: string;
}>;
export type SePayReviewQueue = Readonly<{ items: readonly SePayReviewItem[]; nextCursor: string | null }>;
type Input = Readonly<{
  db: PawketDatabase; keyring: EncryptionKeyring; lookupHmacKey: Uint8Array; assurance: SePayAssurancePort;
  paymentsMode: "disabled" | "manual_only" | "sepay_optional"; environment: "test" | "live"; applicationRevision: string;
  authorizeOwner(tx: PawketTransaction, actor: SePayActor): Promise<boolean>; now?: () => Date;
}>;
const statuses = ["pending", "processing", "review_required", "confirmed", "dismissed"] as const;
export function createSePayReviewService(input: Input) {
  const crypt = createSePayCryptography(input); const now = input.now ?? (() => new Date());
  return {
    async list(command: { actor: SePayActor; status?: string; cursor?: string }): Promise<SePayReviewQueue> {
      validateSePayActor(command.actor); const status = command.status ?? "review_required";
      if (!(statuses as readonly string[]).includes(status) || (command.cursor !== undefined && !sepayUuid(command.cursor))) sepayFail("invalid_request");
      return sepayBoundary(() => input.db.transaction(async (tx) => {
        requireSePayAssurance(await input.assurance.getTipSessionAssurance(tx, command.actor, now()), now(), false);
        const creatorFilter = and(eq(paymentsSepayConnections.creatorUserId, command.actor.userId), eq(paymentsSepayConnections.providerEnvironment, input.environment));
        const [cursor] = command.cursor ? await tx.select({ at: paymentsSepayInbox.receivedAt, id: paymentsSepayInbox.id }).from(paymentsSepayInbox)
          .innerJoin(paymentsSepayConnections, eq(paymentsSepayConnections.id, paymentsSepayInbox.connectionId))
          .where(and(creatorFilter, eq(paymentsSepayInbox.id, command.cursor))).limit(1) : [];
        if (command.cursor && !cursor) sepayFail("invalid_request");
        const rows = await tx.select({ inbox: paymentsSepayInbox, state: paymentsSepayProcessing }).from(paymentsSepayInbox)
          .innerJoin(paymentsSepayConnections, eq(paymentsSepayConnections.id, paymentsSepayInbox.connectionId))
          .innerJoin(paymentsSepayProcessing, eq(paymentsSepayProcessing.inboxId, paymentsSepayInbox.id))
          .where(and(creatorFilter, eq(paymentsSepayProcessing.status, status), cursor ? or(lt(paymentsSepayInbox.receivedAt, cursor.at), and(eq(paymentsSepayInbox.receivedAt, cursor.at), lt(paymentsSepayInbox.id, cursor.id))) : undefined))
          .orderBy(desc(paymentsSepayInbox.receivedAt), desc(paymentsSepayInbox.id)).limit(51);
        const items = rows.slice(0, 50).map(({ inbox, state }): SePayReviewItem => {
          const evidence = inbox.rawEnvelope ? parseAuthenticatedSePayWebhook(Buffer.from(crypt.decrypt("sepay_inbox", inbox.id, "raw_body", inbox.rawEnvelope), "utf8")) : null;
          return { id: inbox.id, connectionId: inbox.connectionId, version: state.version, status: state.status, reason: state.lastErrorCode,
            amountVnd: evidence?.kind === "accepted" ? evidence.event.amountVnd : null, reference: evidence?.kind === "accepted" ? evidence.event.reference : null, receivedAt: inbox.receivedAt.toISOString() };
        });
        return { items, nextCursor: rows.length > 50 ? items[items.length - 1]!.id : null };
      }));
    },
    async decide(command: { actor: SePayActor; inboxId: string; expectedVersion: number; action: "retry" | "dismiss" | "reopen"; reason: string; idempotencyKey: string; requestId: string }): Promise<void> {
      if (input.paymentsMode === "disabled") sepayFail("payments_disabled");
      validateSePayCommand(command);
      if (!sepayUuid(command.inboxId) || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1 || !["retry", "dismiss", "reopen"].includes(command.action) ||
        typeof command.reason !== "string" || command.reason.trim() !== command.reason || command.reason.normalize("NFC") !== command.reason || command.reason.length < 1 || command.reason.length > 500 || /[\u0000-\u001f\u007f]/u.test(command.reason)) sepayFail("invalid_request");
      await sepayBoundary(() => input.db.transaction(async (tx) => {
        const at = now(); const keyHash = crypt.hash("review-decision-key", command.idempotencyKey);
        const started = await beginIdempotentCommand(tx, { actorUserId: command.actor.userId, commandScope: "payments.sepay_review", keyHash,
          requestFingerprint: crypt.hash("review-decision", JSON.stringify([command.inboxId, command.expectedVersion, command.action, command.reason])), now: at, expiresAt: new Date(at.getTime() + 86_400_000) });
        if (started.kind !== "acquired" && started.kind !== "replay") sepayFail("idempotency_conflict");
        requireSePayAssurance(await input.assurance.getTipSessionAssurance(tx, command.actor, now()), now(), false);
        const [source] = await tx.select({ inbox: paymentsSepayInbox, connection: paymentsSepayConnections }).from(paymentsSepayInbox)
          .innerJoin(paymentsSepayConnections, eq(paymentsSepayConnections.id, paymentsSepayInbox.connectionId))
          .where(and(eq(paymentsSepayInbox.id, command.inboxId), eq(paymentsSepayConnections.creatorUserId, command.actor.userId), eq(paymentsSepayConnections.providerEnvironment, input.environment))).limit(1);
        if (!source || source.inbox.disposition !== "accepted") sepayFail("not_available");
        if (started.kind === "replay") return;
        const [state] = await tx.select().from(paymentsSepayProcessing).where(eq(paymentsSepayProcessing.inboxId, command.inboxId)).limit(1).for("update");
        if (!state || state.version !== command.expectedVersion) sepayFail("version_conflict");
        if (state.status === "confirmed" || state.status === "ignored" || (command.action === "reopen" ? state.status !== "dismissed" : state.status !== "review_required")) sepayFail("not_available");
        const status = command.action === "dismiss" ? "dismissed" : command.action === "reopen" ? "review_required" : "pending";
        await tx.update(paymentsSepayProcessing).set({ status, version: state.version + 1, leaseOwner: null, leaseExpiresAt: null,
          availableAt: at, lastErrorCode: command.action === "retry" ? "creator_requested_retry" : state.lastErrorCode, updatedAt: at }).where(eq(paymentsSepayProcessing.inboxId, command.inboxId));
        const decisionId = randomUUID();
        await tx.insert(paymentsSepayDecisions).values({ id: decisionId, inboxId: command.inboxId, action: command.action, reason: command.reason,
          actorUserId: command.actor.userId, actorSessionId: command.actor.sessionId, idempotencyKeyHash: keyHash, expectedVersion: state.version, createdAt: at });
        await appendAdminAuditEvent(tx, { actorUserId: command.actor.userId, actorSessionId: command.actor.sessionId, subjectType: "sepay_inbox", subjectId: command.inboxId,
          action: `sepay.review_${command.action}`, outcome: "succeeded", beforeState: { state: state.status }, afterState: { state: status }, assurance: { method: "current_creator_session" },
          applicationRevision: input.applicationRevision, requestId: command.requestId, occurredAt: at });
        if (!await completeIdempotentCommand(tx, { recordId: started.recordId, resultReference: `sepay-review:${decisionId}`, completedAt: at })) sepayFail("idempotency_conflict");
      }));
    },
    async diagnostics(actor: SePayActor) {
      validateSePayActor(actor);
      return sepayBoundary(() => input.db.transaction(async (tx) => {
        if (!await input.authorizeOwner(tx, actor)) sepayFail("not_authorized");
        const rows = await tx.select({ connection: paymentsSepayConnections, bankName: paymentsReceivingAccountOnboarding.bankName, maskedSuffix: paymentsReceivingAccountOnboarding.maskedSuffix })
          .from(paymentsSepayConnections).innerJoin(paymentsReceivingAccountOnboarding, eq(paymentsReceivingAccountOnboarding.id, paymentsSepayConnections.accountVersionId))
          .where(eq(paymentsSepayConnections.providerEnvironment, input.environment)).orderBy(desc(paymentsSepayConnections.updatedAt)).limit(100);
        const items = [];
        for (const { connection, bankName, maskedSuffix } of rows) {
          const counts = await tx.select({ status: paymentsSepayProcessing.status, value: count() }).from(paymentsSepayProcessing)
            .innerJoin(paymentsSepayInbox, eq(paymentsSepayInbox.id, paymentsSepayProcessing.inboxId))
            .where(and(eq(paymentsSepayInbox.connectionId, connection.id), inArray(paymentsSepayProcessing.status, ["pending", "processing", "review_required"]))).groupBy(paymentsSepayProcessing.status);
          const [latest] = await tx.select({ at: paymentsSepayInbox.receivedAt }).from(paymentsSepayInbox).where(eq(paymentsSepayInbox.connectionId, connection.id)).orderBy(desc(paymentsSepayInbox.receivedAt)).limit(1);
          items.push({ connectionId: connection.id, status: connection.status, version: connection.version, bankName, maskedSuffix,
            pendingCount: counts.filter((item) => item.status !== "review_required").reduce((sum, item) => sum + item.value, 0),
            reviewCount: counts.find((item) => item.status === "review_required")?.value ?? 0, lastReceivedAt: latest?.at.toISOString() ?? null, remoteRevocationStatus: connection.remoteRevocationStatus });
        }
        return { items };
      }));
    },
  };
}
