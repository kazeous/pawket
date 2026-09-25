import { createHash, randomUUID } from "node:crypto";
import {
  appendAdminAuditEvent, beginIdempotentCommand, completeIdempotentCommand, insertOutboxEvent,
  paymentConfirmations, paymentIntents, paymentsSepayAccountCutovers, paymentsSepayConnections,
  paymentsSepayDecisions, paymentsSepayInbox, paymentsSepayInboxConflicts, paymentsSepayProcessing,
  paymentsSepayTransactions, systemCommandIdempotency, type PawketDatabase, type PawketTransaction,
} from "@pawket/database";
import { createLookupHmac, type EncryptionKeyring } from "@pawket/security";
import { and, asc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import type { createSePayConnectionService } from "./sepay-connection-service.js";
import { matchSePayTip } from "./sepay-match.js";
import { SePayProviderError, type SePayProviderPort } from "./sepay-provider.js";
import { parseAuthenticatedSePayWebhook } from "./sepay-webhook.js";
import { readTipIntentSnapshot } from "./tip-snapshot.js";
import { lockTipReceivingDestination } from "./tip-receiving-account.js";
import { createSePayCryptography, requireSePayAssurance, sepayFail, sepayIdentifier, sepayUuid, validateSePayCommand, SePayServiceError, type SePayActor, type SePayAssurancePort } from "./sepay-service-support.js";

type ReviewCommand = { actor: SePayActor; inboxId: string; expectedVersion: number; idempotencyKey: string; requestId: string; attestedReceived: true; reason: string };
type Input = Readonly<{
  db: PawketDatabase; keyring: EncryptionKeyring; lookupHmacKey: Uint8Array;
  paymentsMode: "disabled" | "manual_only" | "sepay_optional"; environment: "test" | "live";
  applicationRevision: string; workerIdentity: string; provider: SePayProviderPort;
  connections: Pick<ReturnType<typeof createSePayConnectionService>, "getReadbackAccess">;
  assurance: SePayAssurancePort;
  tips: { completeTip(tx: PawketTransaction, command: { tipId: string; creatorUserId: string; amountVnd: number; at: Date }): Promise<boolean> };
  now?: () => Date;
  maxAttempts?: number;
  onOperation?: (event: { operation: string; outcome: string; durationSeconds?: number }) => void;
}>;

export function createSePayReconciliationService(input: Input) {
  if (!sepayIdentifier(input.workerIdentity) || input.provider.environment !== input.environment) sepayFail("invalid_request");
  const crypt = createSePayCryptography(input); const now = input.now ?? (() => new Date());
  const maxAttempts = input.maxAttempts ?? 5;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) sepayFail("invalid_request");
  const metric = (event: { operation: string; outcome: string; durationSeconds?: number }) => { try { input.onOperation?.(event); } catch { /* Financial results are independent of telemetry. */ } };
  async function process(inboxId: string, review?: ReviewCommand): Promise<"confirmed" | "review_required" | "deferred" | "unchanged"> {
    if (!sepayUuid(inboxId)) sepayFail("invalid_request");
    if (input.paymentsMode === "disabled") sepayFail("payments_disabled");
    if (review) { validateSePayCommand(review); if (review.attestedReceived !== true || !Number.isSafeInteger(review.expectedVersion) || review.expectedVersion < 1 || typeof review.reason !== "string" || review.reason.trim() !== review.reason || review.reason.length < 1 || review.reason.length > 500 || /[\u0000-\u001f\u007f]/u.test(review.reason)) sepayFail("invalid_request"); }
    const owner = randomUUID();
    const claim = await input.db.transaction(async (tx) => {
      if (review) requireSePayAssurance(await input.assurance.getTipSessionAssurance(tx, review.actor, now()), now(), true);
      const [source] = await tx.select({ inbox: paymentsSepayInbox, connection: paymentsSepayConnections }).from(paymentsSepayInbox)
        .innerJoin(paymentsSepayConnections, eq(paymentsSepayConnections.id, paymentsSepayInbox.connectionId))
        .where(and(eq(paymentsSepayInbox.id, inboxId), eq(paymentsSepayConnections.providerEnvironment, input.environment))).limit(1);
      if (!source || (review && source.connection.creatorUserId !== review.actor.userId)) sepayFail("not_available");
      const [state] = await tx.select().from(paymentsSepayProcessing).where(eq(paymentsSepayProcessing.inboxId, inboxId)).limit(1).for("update");
      if (!state || source.inbox.disposition !== "accepted") return null;
      if (state.status === "confirmed") {
        if (review) {
          const [replay] = await tx.select().from(systemCommandIdempotency).where(and(eq(systemCommandIdempotency.actorUserId, review.actor.userId),
            eq(systemCommandIdempotency.commandScope, "payments.sepay_confirm"), eq(systemCommandIdempotency.keyHash, crypt.hash("review-key", review.idempotencyKey)))).limit(1);
          if (!replay) sepayFail("intent_not_pending");
          if (replay.status !== "completed" || replay.expiresAt <= now() || !replay.resultReference?.startsWith("sepay-confirmed:") ||
            replay.requestFingerprint !== crypt.hash("review-confirm", JSON.stringify([inboxId, review.expectedVersion, true, review.reason]))) sepayFail("idempotency_conflict");
        }
        return { completed: true as const };
      }
      if (review && state.version !== review.expectedVersion) sepayFail("version_conflict");
      if (state.status === "dismissed" || state.status === "ignored" || (state.status === "processing" && state.leaseExpiresAt && state.leaseExpiresAt > now()) || (!review && (state.status === "review_required" || state.availableAt > now()))) return null;
      if (state.attempts >= 100) sepayFail("rate_limited");
      const [taken] = await tx.update(paymentsSepayProcessing).set({ status: "processing", leaseOwner: owner, leaseExpiresAt: new Date(now().getTime() + 60_000),
        attempts: state.attempts + 1, version: state.version + 1, updatedAt: now() }).where(eq(paymentsSepayProcessing.inboxId, inboxId)).returning();
      if (!taken) sepayFail("dependency_unavailable");
      return { completed: false as const, ...source, state: taken };
    });
    if (!claim) return "unchanged";
    if (claim.completed) return "confirmed";
    async function disposition(reason: string, retryAfterSeconds?: number): Promise<"deferred" | "review_required"> {
      const retry = retryAfterSeconds !== undefined && claim && !claim.completed && claim.state.attempts < maxAttempts && !review;
      if (retryAfterSeconds !== undefined && !retry && !review) metric({ operation: "reconcile", outcome: "retry_exhausted" });
      await input.db.transaction(async (tx) => {
        const [changed] = await tx.update(paymentsSepayProcessing).set({ status: retry ? "pending" : "review_required", version: sql`${paymentsSepayProcessing.version} + 1`,
          leaseOwner: null, leaseExpiresAt: null, lastErrorCode: reason, availableAt: new Date(now().getTime() + (retryAfterSeconds ?? 0) * 1_000), updatedAt: now() })
          .where(and(eq(paymentsSepayProcessing.inboxId, inboxId), eq(paymentsSepayProcessing.leaseOwner, owner), eq(paymentsSepayProcessing.status, "processing"))).returning();
        if (changed && !retry) await tx.insert(paymentsSepayDecisions).values({ id: randomUUID(), inboxId, action: "review_required", reason,
          expectedVersion: changed.version - 1, createdAt: now() });
      });
      return retry ? "deferred" : "review_required";
    }
    try {
      if (!review && (input.paymentsMode !== "sepay_optional" || !claim.connection.automationEnabled)) return disposition("automation_paused");
      if (claim.connection.status !== "ready") return disposition("connection_not_ready");
      if (!claim.inbox.rawEnvelope) return disposition("invalid_evidence");
      const raw = Buffer.from(crypt.decrypt("sepay_inbox", inboxId, "raw_body", claim.inbox.rawEnvelope), "utf8");
      if (`sha256:${createHash("sha256").update(raw).digest("hex")}` !== claim.inbox.payloadDigest) return disposition("invalid_evidence");
      const parsed = parseAuthenticatedSePayWebhook(raw);
      if (parsed.kind !== "accepted" || parsed.event.id !== claim.inbox.providerEventId || !parsed.event.reference) return disposition("reference_mismatch");
      const event = parsed.event;
      const referenceHash = createLookupHmac({ key: input.lookupHmacKey, context: "tip-transfer-reference", value: event.reference! });
      const [candidate] = await input.db.select().from(paymentIntents).where(and(eq(paymentIntents.referenceHash, referenceHash), eq(paymentIntents.creatorUserId, claim.connection.creatorUserId))).limit(1);
      if (!candidate) return disposition("not_found");
      if (candidate.settlementLane !== "provider_bound" || !candidate.cutoverId) return disposition("manual_lane");
      if (candidate.state !== "awaiting_transfer" || candidate.expiresAt <= now()) return disposition("intent_not_pending");
      const access = await input.connections.getReadbackAccess(claim.connection.id);
      if (!access.grant.binding || access.connection.status !== "ready") return disposition("connection_not_ready");
      const binding = access.grant.binding;
      const [cutover] = await input.db.select().from(paymentsSepayAccountCutovers).where(eq(paymentsSepayAccountCutovers.id, candidate.cutoverId)).limit(1);
      if (!cutover || cutover.connectionId !== access.connection.id) return disposition("identity_mismatch");
      const { snapshot, transferReference } = readTipIntentSnapshot(candidate, input);
      const lookupStartedAt = Date.now();
      const readback = await input.provider.readback({ accessToken: access.grant.accessToken, binding, event,
        from: candidate.createdAt, to: new Date(Math.min(candidate.expiresAt.getTime(), now().getTime())) });
      metric({ operation: "lookup", outcome: readback.kind, durationSeconds: (Date.now() - lookupStartedAt) / 1000 });
      const matchInput = { intent: { settlementLane: "provider_bound" as const, state: candidate.state as "awaiting_transfer", amountVnd: candidate.amountVnd,
        transferReference, bankBin: snapshot.bankBin, accountNumber: snapshot.accountNumber, createdAt: candidate.createdAt, expiresAt: candidate.expiresAt, cutoverAt: cutover.cutoverAt },
        binding, event, readback, capabilities: input.provider.capabilities };
      const matched = matchSePayTip({ ...matchInput, now: now() });
      if (matched.kind !== "matched") return disposition(matched.reason);
      const transaction = matched.transaction;
      return await input.db.transaction(async (tx) => {
        const keyHash = review ? crypt.hash("review-key", review.idempotencyKey) : crypt.hash("automatic-confirm", inboxId);
        const started = review ? await beginIdempotentCommand(tx, { actorUserId: review.actor.userId, commandScope: "payments.sepay_confirm", keyHash,
          requestFingerprint: crypt.hash("review-confirm", JSON.stringify([inboxId, review.expectedVersion, true, review.reason])), now: now(), expiresAt: new Date(now().getTime() + 86_400_000) }) : null;
        if (started && started.kind !== "acquired") sepayFail("idempotency_conflict");
        const proof = review ? requireSePayAssurance(await input.assurance.getTipSessionAssurance(tx, review.actor, now()), now(), true) : null;
        const destination = await lockTipReceivingDestination(tx, candidate.creatorUserId, now(), input);
        if (!destination || destination.accountVersionId !== candidate.accountVersionId || destination.accountFingerprint !== access.connection.accountFingerprint) sepayFail("evidence_mismatch");
        const [connection] = await tx.select().from(paymentsSepayConnections).where(eq(paymentsSepayConnections.id, access.connection.id)).limit(1).for("update");
        if (!connection || connection.version !== access.connection.version || connection.currentRevisionId !== access.rev.id || connection.status !== "ready" || connection.accountVersionId !== candidate.accountVersionId ||
          connection.providerTenantId !== binding.tenantId || connection.providerAccountId !== binding.accountId || (!review && !connection.automationEnabled)) sepayFail("version_conflict");
        // Match the DB's canonical identity lock; JSONB text preserves the same key.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('payments:sepay-transaction:' || jsonb_build_array(${binding.environment}::text, ${binding.tenantId}::text, ${binding.accountId}::text, ${transaction.id}::text)::text, 0))`);
        const [intent] = await tx.select().from(paymentIntents).where(eq(paymentIntents.id, candidate.id)).limit(1).for("update");
        const [state] = await tx.select().from(paymentsSepayProcessing).where(eq(paymentsSepayProcessing.inboxId, inboxId)).limit(1).for("update");
        const [conflict] = await tx.select({ id: paymentsSepayInboxConflicts.inboxId }).from(paymentsSepayInboxConflicts).where(eq(paymentsSepayInboxConflicts.inboxId, inboxId)).limit(1);
        const at = now();
        if (!intent || intent.state !== "awaiting_transfer" || intent.expiresAt <= at || intent.cutoverId !== candidate.cutoverId || intent.settlementLane !== "provider_bound") sepayFail("intent_not_pending");
        if (!state || state.status !== "processing" || state.leaseOwner !== owner || !state.leaseExpiresAt || state.leaseExpiresAt <= at || conflict) sepayFail("evidence_mismatch");
        if (matchSePayTip({ ...matchInput, now: at }).kind !== "matched" || access.grant.expiresAt <= at) sepayFail("evidence_mismatch");
        if (proof) requireSePayAssurance(proof, at, true);
        const transactionId = randomUUID(); const confirmationId = randomUUID(); const requestId = review?.requestId ?? randomUUID();
        const [reserved] = await tx.insert(paymentsSepayTransactions).values({ id: transactionId, providerEnvironment: binding.environment, providerTenantId: binding.tenantId,
          providerAccountId: binding.accountId, providerTransactionId: transaction.id, connectionId: connection.id, connectionRevisionId: access.rev.id, connectionVersion: connection.version,
          inboxId, paymentIntentId: intent.id, amountVnd: intent.amountVnd, referenceHash: intent.referenceHash, accountFingerprint: destination.accountFingerprint,
          transferAt: transaction.occurredAt, verifiedAt: at, readbackDigest: `sha256:${createHash("sha256").update(JSON.stringify(transaction)).digest("hex")}` }).onConflictDoNothing().returning();
        if (!reserved) sepayFail("evidence_mismatch");
        await tx.insert(paymentConfirmations).values({ id: confirmationId, paymentIntentId: intent.id, creatorUserId: intent.creatorUserId, accountVersionId: intent.accountVersionId,
          observedAmountVnd: intent.amountVnd, referenceHash: intent.referenceHash, bankTransactionFingerprint: null, providerTransactionId: transactionId,
          source: review ? "creator_reviewed_sepay" : "sepay_automatic", workerIdentity: review ? null : input.workerIdentity, attestedReceived: review ? true : null,
          actorSessionId: review?.actor.sessionId ?? null, primaryAuthenticatedAt: proof?.primaryAuthenticatedAt ?? null, totpVerifiedAt: proof?.totpEnrolled ? proof.totpVerifiedAt : null,
          idempotencyKeyHash: review ? keyHash : null, requestId, confirmedAt: at });
        const [confirmed] = await tx.update(paymentIntents).set({ state: "confirmed", closedAt: at, updatedAt: at }).where(and(eq(paymentIntents.id, intent.id), eq(paymentIntents.state, "awaiting_transfer"), gt(paymentIntents.expiresAt, at))).returning();
        if (!confirmed || !await input.tips.completeTip(tx, { tipId: intent.tipId, creatorUserId: intent.creatorUserId, amountVnd: intent.amountVnd, at })) sepayFail("intent_not_pending");
        await tx.update(paymentsSepayProcessing).set({ status: "confirmed", version: state.version + 1, leaseOwner: null, leaseExpiresAt: null, lastErrorCode: null, updatedAt: at }).where(eq(paymentsSepayProcessing.inboxId, inboxId));
        await tx.insert(paymentsSepayDecisions).values({ id: randomUUID(), inboxId, action: "confirmed", reason: review?.reason ?? "exact_provider_readback", expectedVersion: state.version,
          actorUserId: review?.actor.userId ?? null, actorSessionId: review?.actor.sessionId ?? null, idempotencyKeyHash: review ? keyHash : null, createdAt: at });
        await appendAdminAuditEvent(tx, { actorUserId: review?.actor.userId ?? `system:${input.workerIdentity}`, actorSessionId: review?.actor.sessionId ?? null,
          subjectType: "payment_intent", subjectId: intent.id, action: "tip.confirmed", outcome: "succeeded", beforeState: { state: "awaiting_transfer" },
          afterState: { state: "confirmed", confirmationId }, assurance: { method: review ? "creator_attestation_provider_readback" : "worker_provider_readback" },
          applicationRevision: input.applicationRevision, requestId, occurredAt: at });
        await insertOutboxEvent(tx, { eventType: "tip.confirmed.v1", eventVersion: 1, aggregateType: "payment_intent", aggregateId: intent.id,
          payload: { paymentIntentId: intent.id, tipId: intent.tipId, creatorUserId: intent.creatorUserId, confirmationId, correlationId: requestId }, occurredAt: at });
        if (started?.kind === "acquired" && !await completeIdempotentCommand(tx, { recordId: started.recordId, resultReference: `sepay-confirmed:${confirmationId}`, completedAt: at })) sepayFail("idempotency_conflict");
        return "confirmed" as const;
      });
    } catch (error) {
      if (error instanceof SePayProviderError) {
        metric({ operation: "lookup", outcome: error.code === "rate_limited" ? "rate_limited" : "failed" });
        if (error.code === "rate_limited" || error.code === "unavailable") return disposition(error.code, error.retryAfterSeconds ?? Math.min(900, 2 ** claim.state.attempts * 10));
        return disposition(error.code);
      }
      if (error instanceof SePayServiceError) return disposition(error.code, error.retryAfterSeconds);
      return disposition("dependency_unavailable", 60);
    }
  }
  return {
    async processInbox(inboxId: string) { const outcome = await process(inboxId); metric({ operation: "reconcile", outcome }); return outcome; },
    async confirmReviewed(command: ReviewCommand) { const outcome = await process(command.inboxId, command); metric({ operation: "reconcile", outcome }); return outcome; },
    async recoverDue(limit = 20): Promise<number> {
      if (input.paymentsMode === "disabled") return 0;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) sepayFail("invalid_request");
      const rows = await input.db.select({ id: paymentsSepayProcessing.inboxId }).from(paymentsSepayProcessing)
        .innerJoin(paymentsSepayInbox, eq(paymentsSepayInbox.id, paymentsSepayProcessing.inboxId))
        .innerJoin(paymentsSepayConnections, eq(paymentsSepayConnections.id, paymentsSepayInbox.connectionId))
        .where(and(eq(paymentsSepayConnections.providerEnvironment, input.environment), inArray(paymentsSepayProcessing.status, ["pending", "processing"]),
          lte(paymentsSepayProcessing.availableAt, now()), or(eq(paymentsSepayProcessing.status, "pending"), lte(paymentsSepayProcessing.leaseExpiresAt, now()))))
        .orderBy(asc(paymentsSepayProcessing.availableAt), asc(paymentsSepayProcessing.inboxId)).limit(limit);
      const started = Date.now(); let processed = 0;
      for (const row of rows) {
        if (Date.now() - started >= 15_000) break;
        await process(row.id); processed++;
      }
      return processed;
    },
  };
}
