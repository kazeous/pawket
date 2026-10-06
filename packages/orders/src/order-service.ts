import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray, isNull, lt, notInArray, or } from "drizzle-orm";
import {
  appendAdminAuditEvent, beginIdempotentCommand, completeIdempotentCommand, insertOutboxEvent,
  commissionAcceptances, commissionBriefs, commissionEvents, commissionOrders, commissionPackageRevisions,
  commissionPolicyRevisions, commissionQuoteRevisions, commissionReservations, commissionSubmissions, commissionTermsSnapshots,
  type PawketDatabase, type PawketTransaction,
} from "@pawket/database";
import { createLookupHmac, type EncryptionKeyring } from "@pawket/security";
import { CommissionError, commissionFail, type CommissionActor, type CommissionState, type CommissionTerms } from "./contracts.js";
import { COMMISSION_POLICY, commissionIdentifier, commissionIdempotencyKey, commissionInteger, commissionPaymentExpiry,
  commissionQuoteExpiry, commissionRequestExpiry, commissionTime, commissionUuid, normalizeCommissionBrief, normalizeCommissionTerms, requireCommissionBeforeDeadline } from "./policy.js";
import { createCommissionPaymentLifecyclePort, lockCommissionCreator } from "./payment-lifecycle.js";
import { decryptCommissionBrief, decryptCommissionTerms, encryptCommissionBrief, encryptCommissionTerms } from "./private-content.js";
import { commissionExpiredReason as expiredReason, createCommissionOrderPersistence } from "./order-persistence.js";
import { createCommissionOrderMaintenanceService } from "./order-maintenance.js";
import { createCommissionFulfillmentService, readCommissionCompletionDueAt } from "./fulfillment-service.js";
import { commissionFileDeletionAt } from "./fulfillment-timing.js";
import { commissionCommandFingerprint } from "./command-fingerprint.js";
import { requireCommissionPolicy, type CommissionPolicyReadPort } from "./policy-repository.js";
import type { CommissionCatalogPort, CommissionCompletionHoldPort, CommissionFilesPort, CommissionIdentityPort, CommissionIntakePackage, CommissionPaymentsPort, CommissionThreadPort } from "./ports.js";

type Order = typeof commissionOrders.$inferSelect;
type Quote = typeof commissionQuoteRevisions.$inferSelect;
type Command = Readonly<{ actor: CommissionActor; idempotencyKey: string; requestId: string }>;
type ExistingCommand = Command & Readonly<{ orderId: string; expectedVersion: number }>;
type Input = Readonly<{
  db: PawketDatabase; keyring: EncryptionKeyring; lookupHmacKey: Uint8Array; applicationRevision: string;
  intakeMode: "disabled" | "enabled"; paymentsMode: "disabled" | "manual_only" | "sepay_optional";
  fulfillmentMode: "disabled" | "enabled"; thread?: CommissionThreadPort; holds?: CommissionCompletionHoldPort;
  identity: CommissionIdentityPort; catalog: CommissionCatalogPort; payments: CommissionPaymentsPort; policy: CommissionPolicyReadPort;
  trust: { lockCommissionPage(tx: PawketTransaction, creatorUserId: string): Promise<boolean> };
  files?: CommissionFilesPort;
  authorizeCommand?: (tx: PawketTransaction, actor: CommissionActor) => Promise<void>;
  now?: () => Date; idFactory?: () => string;
}>;
type Change = { orderId: string; at: Date; guardUntil?: Date };
function actorValid(actor: CommissionActor) {
  if (!actor || !commissionIdentifier(actor.userId) || !commissionIdentifier(actor.sessionId)) commissionFail("not_authorized");
}
function existingValid(command: ExistingCommand) {
  if (!commissionUuid(command.orderId)) commissionFail("invalid_request");
  commissionInteger(command.expectedVersion, 1, 2_147_483_646);
}
function referenceIds(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10 || !value.every(commissionUuid) || new Set(value).size !== value.length) commissionFail("invalid_request");
  return Object.freeze([...value]);
}
export function createCommissionOrderService(input: Input) {
  if (!commissionIdentifier(input.applicationRevision) || input.lookupHmacKey.length < 32) commissionFail("invalid_request");
  const clock = input.now ?? (() => new Date()); const id = input.idFactory ?? randomUUID; const key = new Uint8Array(input.lookupHmacKey);
  const now = () => { const at = clock(); commissionTime(at); return new Date(at); };
  const newId = () => { const value = id(); if (!commissionUuid(value)) commissionFail("dependency_unavailable"); return value; };
  const digest = (context: string, value: string) => createLookupHmac({ key, context, value });
  const eligibility = { lockSettlementParticipants: async (tx: PawketTransaction, command: { creatorUserId: string; buyerUserId: string; at: Date }) =>
    await input.identity.lockSettlementParticipants(tx, command) && await input.trust.lockCommissionPage(tx, command.creatorUserId) };
  const paymentsLifecycle = createCommissionPaymentLifecyclePort({ eligibility, idFactory: id });
  async function boundary<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) {
      if (error instanceof CommissionError) throw error;
      // Payments keeps its released error contract; expose only known domain codes.
      if (error instanceof Error && error.name === "TipPaymentError" && "code" in error) {
        if (error.code === "not_available" || error.code === "payments_disabled" || error.code === "idempotency_conflict") commissionFail(error.code);
        if (error.code === "intent_not_pending") commissionFail("invalid_transition");
      }
      return commissionFail("dependency_unavailable");
    }
  }
  async function session(tx: PawketTransaction, actor: CommissionActor) {
    const at = now(); const proof = await input.identity.getTipSessionAssurance(tx, actor, at);
    if (!proof || !(proof.sessionExpiresAt instanceof Date) || !Number.isFinite(proof.sessionExpiresAt.getTime()) || proof.sessionExpiresAt <= at) commissionFail("not_authorized");
    return proof.sessionExpiresAt;
  }
  async function owned(tx: PawketTransaction, orderId: string, actor: CommissionActor): Promise<Order> {
    const [order] = await tx.select().from(commissionOrders).where(and(eq(commissionOrders.id, orderId), or(eq(commissionOrders.buyerUserId, actor.userId), eq(commissionOrders.creatorUserId, actor.userId)))).limit(1);
    if (!order) commissionFail("not_authorized"); return order;
  }
  async function participants(tx: PawketTransaction, creatorUserId: string, buyerUserId: string) {
    if (creatorUserId === buyerUserId || !await eligibility.lockSettlementParticipants(tx, { creatorUserId, buyerUserId, at: now() })) commissionFail("not_available");
  }
  const { record, closeOrder, completeCommissionOrder } = createCommissionOrderPersistence({ ...input, newId });
  async function mutate(command: Command, scope: string, payload: unknown,
    creator: (tx: PawketTransaction) => Promise<string>, apply: (tx: PawketTransaction) => Promise<Change>): Promise<string> {
    actorValid(command.actor);
    if (!commissionIdentifier(command.requestId) || !commissionIdempotencyKey(command.idempotencyKey)) commissionFail("invalid_request");
    return boundary(() => input.db.transaction(async (tx) => {
      const startedAt = now();
      const started = await beginIdempotentCommand(tx, { actorUserId: command.actor.userId, commandScope: `orders.commission.${scope}`,
        keyHash: digest("commission-command-key", command.idempotencyKey), requestFingerprint: commissionCommandFingerprint(key, "commission-command", [scope, command.actor.userId, payload]),
        now: startedAt, expiresAt: new Date(startedAt.getTime() + 86_400_000) });
      if (started.kind !== "acquired" && started.kind !== "replay") commissionFail("idempotency_conflict");
      await lockCommissionCreator(tx, await creator(tx));
      const sessionExpiresAt = await session(tx, command.actor);
      if (started.kind === "replay") {
        await owned(tx, started.resultReference, command.actor);
        if (sessionExpiresAt <= now()) commissionFail("not_authorized");
        await input.authorizeCommand?.(tx, command.actor);
        return started.resultReference;
      }
      const changed = await apply(tx); const completedAt = now();
      if (completedAt < startedAt || completedAt < changed.at || completedAt >= sessionExpiresAt) commissionFail("not_authorized");
      if (changed.guardUntil) requireCommissionBeforeDeadline(completedAt, changed.guardUntil);
      if (!await completeIdempotentCommand(tx, { recordId: started.recordId, resultReference: changed.orderId, completedAt })) commissionFail("idempotency_conflict");
      await input.authorizeCommand?.(tx, command.actor);
      return changed.orderId;
    }));
  }
  const orderCreator = (command: ExistingCommand) => async (tx: PawketTransaction) => (await owned(tx, command.orderId, command.actor)).creatorUserId;
  function pending(order: Order, expectedVersion: number) {
    if (order.version !== expectedVersion) commissionFail("version_conflict");
    if (!order.expiresAt || !["requested", "quoted", "awaiting_payment"].includes(order.state)) commissionFail("invalid_transition");
    requireCommissionBeforeDeadline(now(), order.expiresAt);
  }
  async function intake(tx: PawketTransaction, order: Order, requirePayment: boolean): Promise<CommissionIntakePackage> {
    if (input.intakeMode !== "enabled") commissionFail("intake_disabled");
    if (requirePayment && input.paymentsMode === "disabled") commissionFail("payments_disabled");
    await participants(tx, order.creatorUserId, order.buyerUserId);
    return input.catalog.getIntakePackage(tx, { packageId: order.packageId, revisionId: order.packageRevisionId, allowPreviousRevision: true, requirePayment, at: now() });
  }
  async function reserve(tx: PawketTransaction, order: Order, data: CommissionIntakePackage, at: Date) {
    const [used] = await tx.select({ count: count() }).from(commissionReservations).where(and(eq(commissionReservations.creatorUserId, order.creatorUserId), inArray(commissionReservations.state, ["reserved", "occupied"])));
    if ((used?.count ?? 0) >= data.capacityLimit) commissionFail("capacity_full");
    await tx.insert(commissionReservations).values({ orderId: order.id, creatorUserId: order.creatorUserId, reservedAt: at });
  }
  async function acceptance(tx: PawketTransaction, order: Order, role: "buyer" | "creator", actor: CommissionActor, at: Date, policyRevisionId: string, quoteRevisionId: string | null, requestId: string) {
    await tx.insert(commissionAcceptances).values({ id: newId(), orderId: order.id, role, actorUserId: actor.userId, actorSessionId: actor.sessionId,
      packageRevisionId: order.packageRevisionId, quoteRevisionId, policyRevisionId, requestId, acceptedAt: at });
  }
  async function commitTerms(tx: PawketTransaction, order: Order, data: CommissionIntakePackage, terms: CommissionTerms,
    buyerAt: Date, creatorAt: Date, quoteId: string | null, at: Date, requestId: string, abuseKeyHash: string) {
    if (!data.accountVersionId || !commissionUuid(data.accountVersionId)) commissionFail("not_available");
    await reserve(tx, order, data, at);
    await tx.insert(commissionTermsSnapshots).values({ orderId: order.id, packageRevisionId: order.packageRevisionId, quoteRevisionId: quoteId,
      ...encryptCommissionTerms(input.keyring, "commission_terms_snapshots", order.id, terms), buyerAcceptedAt: buyerAt, creatorAcceptedAt: creatorAt, createdAt: at });
    await input.payments.createIntent(tx, { orderId: order.id, creatorUserId: order.creatorUserId, accountVersionId: data.accountVersionId, amountVnd: terms.amountVnd,
      creator: { displayName: data.creator.displayName, handle: data.creator.canonicalHandle }, abuseKeyHash, requestId, at });
  }
  return {
    paymentsLifecycle,
    async request(command: Command & { packageId: string; revisionId: string; policyRevisionId: string; acceptTerms: boolean; brief: unknown; abuseKeyHash: string; referenceFileIds?: readonly string[] }) {
      if (!commissionUuid(command.packageId) || !commissionUuid(command.revisionId) || !commissionUuid(command.policyRevisionId) || typeof command.acceptTerms !== "boolean" ||
        !/^hmac-sha256:v1:[A-Za-z0-9_-]{43}$/u.test(command.abuseKeyHash)) commissionFail("invalid_request");
      const brief = normalizeCommissionBrief(command.brief);
      const fileIds = referenceIds(command.referenceFileIds);
      const find = async (tx: PawketTransaction) => { const row = await input.catalog.findPackageIdentity(tx, command.packageId); if (!row) commissionFail("not_available"); return row; };
      return mutate(command, "request", [command.packageId, command.revisionId, command.policyRevisionId, command.acceptTerms, brief, command.abuseKeyHash, ...(fileIds.length ? [fileIds] : [])], async (tx) => (await find(tx)).creatorUserId, async (tx) => {
        if (input.intakeMode !== "enabled") commissionFail("intake_disabled");
        const candidate = await find(tx); await participants(tx, candidate.creatorUserId, command.actor.userId);
        const immediate = candidate.route === "fixed_immediate";
        if (immediate && input.paymentsMode === "disabled") commissionFail("payments_disabled");
        const data = await input.catalog.getIntakePackage(tx, { packageId: command.packageId, revisionId: command.revisionId, allowPreviousRevision: false, requirePayment: immediate, at: now() });
        requireCommissionPolicy(data.policy, command.policyRevisionId);
        const route = data.revision.route;
        if (route !== "custom_quote" && command.acceptTerms !== true) commissionFail("invalid_terms");
        const [open] = await tx.select({ count: count() }).from(commissionOrders).where(and(eq(commissionOrders.creatorUserId, candidate.creatorUserId), eq(commissionOrders.buyerUserId, command.actor.userId), notInArray(commissionOrders.state, ["closed", "completed"])));
        if ((open?.count ?? 0) >= COMMISSION_POLICY.maximumOpenPairOrders) commissionFail("request_limit");
        const terms = route === "custom_quote" ? null : normalizeCommissionTerms(data.revision.terms);
        const at = now(); const orderId = newId();
        const [order] = await tx.insert(commissionOrders).values({ id: orderId, creatorUserId: candidate.creatorUserId, buyerUserId: command.actor.userId,
          packageId: command.packageId, packageRevisionId: command.revisionId, route, state: immediate ? "awaiting_payment" : "requested",
          amountVnd: immediate ? terms!.amountVnd : null, acceptedAt: immediate ? at : null,
          expiresAt: immediate ? commissionPaymentExpiry(at) : commissionRequestExpiry(at), createdAt: at, updatedAt: at }).returning();
        if (!order) commissionFail("dependency_unavailable");
        await tx.insert(commissionBriefs).values({ orderId, ...encryptCommissionBrief(input.keyring, orderId, brief), buyerSessionId: command.actor.sessionId, requestId: command.requestId, createdAt: at });
        if (fileIds.length) {
          if (!input.files) commissionFail("files_disabled");
          const attached = await input.files.attachBriefFiles(tx, { orderId, buyerUserId: command.actor.userId, packageId: command.packageId, fileIds, at });
          if (attached === "disabled") commissionFail("files_disabled");
          if (attached !== "attached") commissionFail("invalid_reference_files");
        }
        if (terms) await acceptance(tx, order, "buyer", command.actor, at, terms.policyRevisionId, null, command.requestId);
        if (immediate) {
          await acceptance(tx, order, "creator", { userId: order.creatorUserId, sessionId: data.revision.actorSessionId }, data.revision.publishedAt, terms!.policyRevisionId, null, data.revision.requestId);
          await commitTerms(tx, order, data, terms!, at, data.revision.publishedAt, null, at, command.requestId, command.abuseKeyHash);
        }
        await record(tx, order, command.actor, command.requestId); return { orderId, at, guardUntil: order.expiresAt! };
      });
    },
    async quote(command: ExistingCommand & { terms: unknown; ttlMs: number }) {
      existingValid(command); const terms = normalizeCommissionTerms(command.terms);
      commissionInteger(command.ttlMs, COMMISSION_POLICY.minimumQuoteTtlMs, COMMISSION_POLICY.maximumQuoteTtlMs);
      return mutate(command, "quote", [command.orderId, command.expectedVersion, terms, command.ttlMs], orderCreator(command), async (tx) => {
        const order = await owned(tx, command.orderId, command.actor); pending(order, command.expectedVersion);
        if (order.creatorUserId !== command.actor.userId) commissionFail("not_authorized");
        if (order.route !== "custom_quote" || !["requested", "quoted"].includes(order.state)) commissionFail("invalid_transition");
        await intake(tx, order, false);
        requireCommissionPolicy(await input.policy.readCurrent(tx, now()), terms.policyRevisionId);
        const [previous] = await tx.select().from(commissionQuoteRevisions).where(eq(commissionQuoteRevisions.orderId, order.id)).orderBy(desc(commissionQuoteRevisions.revisionNumber)).limit(1);
        const at = now(); requireCommissionBeforeDeadline(at, order.expiresAt!);
        const quoteId = newId(); const expiresAt = commissionQuoteExpiry(order.createdAt, at, command.ttlMs);
        await tx.insert(commissionQuoteRevisions).values({ id: quoteId, orderId: order.id, revisionNumber: (previous?.revisionNumber ?? 0) + 1,
          ...encryptCommissionTerms(input.keyring, "commission_quote_revisions", quoteId, terms), actorSessionId: command.actor.sessionId, requestId: command.requestId, issuedAt: at, expiresAt });
        const [quoted] = await tx.update(commissionOrders).set({ state: "quoted", version: order.version + 1, currentQuoteId: quoteId, expiresAt, updatedAt: at }).where(eq(commissionOrders.id, order.id)).returning();
        if (!quoted) commissionFail("version_conflict");
        await record(tx, quoted, command.actor, command.requestId); return { orderId: order.id, at, guardUntil: order.expiresAt! };
      });
    },
    async accept(command: ExistingCommand & { quoteRevisionId: string | null; policyRevisionId: string; acceptTerms: boolean; abuseKeyHash: string }) {
      existingValid(command);
      if (!commissionUuid(command.policyRevisionId) || (command.quoteRevisionId !== null && !commissionUuid(command.quoteRevisionId)) || command.acceptTerms !== true ||
        !/^hmac-sha256:v1:[A-Za-z0-9_-]{43}$/u.test(command.abuseKeyHash)) commissionFail("invalid_request");
      return mutate(command, "accept", [command.orderId, command.expectedVersion, command.quoteRevisionId, command.policyRevisionId, true, command.abuseKeyHash], orderCreator(command), async (tx) => {
        const order = await owned(tx, command.orderId, command.actor); pending(order, command.expectedVersion);
        const fixed = order.route === "fixed_approval" && order.state === "requested";
        if (fixed ? order.creatorUserId !== command.actor.userId : order.buyerUserId !== command.actor.userId) commissionFail("not_authorized");
        if (!fixed && (order.route !== "custom_quote" || order.state !== "quoted")) commissionFail("invalid_transition");
        const data = await intake(tx, order, true); let quote: Quote | null = null;
        if (!fixed) {
          if (order.currentQuoteId !== command.quoteRevisionId) commissionFail("version_conflict");
          const [currentQuote] = await tx.select().from(commissionQuoteRevisions).where(and(eq(commissionQuoteRevisions.id, command.quoteRevisionId!), eq(commissionQuoteRevisions.orderId, order.id))).limit(1);
          quote = currentQuote ?? null;
          if (!quote) commissionFail("not_available");
        } else if (command.quoteRevisionId !== null) commissionFail("invalid_request");
        const terms = quote ? decryptCommissionTerms(input.keyring, "commission_quote_revisions", quote.id, quote) : normalizeCommissionTerms(data.revision.terms);
        if (terms.policyRevisionId !== command.policyRevisionId) commissionFail("policy_changed");
        requireCommissionPolicy(await input.policy.readCurrent(tx, now()), terms.policyRevisionId);
        const at = now(); requireCommissionBeforeDeadline(at, order.expiresAt!);
        const [accepted] = await tx.update(commissionOrders).set({ state: "awaiting_payment", version: order.version + 1, acceptedAt: at,
          amountVnd: terms.amountVnd, expiresAt: commissionPaymentExpiry(at), updatedAt: at }).where(eq(commissionOrders.id, order.id)).returning();
        if (!accepted) commissionFail("version_conflict");
        if (fixed) await acceptance(tx, accepted, "creator", command.actor, at, terms.policyRevisionId, null, command.requestId);
        else {
          await acceptance(tx, accepted, "buyer", command.actor, at, terms.policyRevisionId, quote!.id, command.requestId);
          await acceptance(tx, accepted, "creator", { userId: order.creatorUserId, sessionId: quote!.actorSessionId }, quote!.issuedAt, terms.policyRevisionId, quote!.id, quote!.requestId);
        }
        await commitTerms(tx, accepted, data, terms, fixed ? order.createdAt : at, fixed ? at : quote!.issuedAt, quote?.id ?? null, at, command.requestId, command.abuseKeyHash);
        await record(tx, accepted, command.actor, command.requestId); return { orderId: order.id, at, guardUntil: order.expiresAt! };
      });
    },
    async close(command: ExistingCommand) {
      existingValid(command);
      return mutate(command, "close", [command.orderId, command.expectedVersion], orderCreator(command), async (tx) => {
        const order = await owned(tx, command.orderId, command.actor);
        if (order.version !== command.expectedVersion) commissionFail("version_conflict");
        if (!order.expiresAt || !["requested", "quoted", "awaiting_payment"].includes(order.state)) commissionFail("invalid_transition");
        const at = now(); const buyer = order.buyerUserId === command.actor.userId;
        const reason = at >= order.expiresAt ? expiredReason(order.state) : order.state === "requested" ? (buyer ? "buyer_withdrawn" : "creator_declined")
          : order.state === "quoted" ? (buyer ? "quote_declined" : "quote_withdrawn") : (buyer ? "buyer_cancelled" : "creator_cancelled");
        await closeOrder(tx, order, reason, command.actor, command.requestId, at); return { orderId: order.id, at };
      });
    },
    async claimTransfer(command: ExistingCommand) {
      existingValid(command);
      return mutate(command, "claim", [command.orderId, command.expectedVersion], orderCreator(command), async (tx) => {
        const order = await owned(tx, command.orderId, command.actor); pending(order, command.expectedVersion);
        if (order.buyerUserId !== command.actor.userId) commissionFail("not_authorized");
        if (order.state !== "awaiting_payment") commissionFail("invalid_transition");
        if (input.paymentsMode === "disabled") commissionFail("payments_disabled");
        if (!await paymentsLifecycle.lockSettlement(tx, { orderId: order.id, creatorUserId: order.creatorUserId, at: now() })) commissionFail("not_available");
        if (!await input.payments.hasCurrentDestination(tx, { orderId: order.id, creatorUserId: order.creatorUserId, at: now() })) commissionFail("not_available");
        const at = now(); const claim = await input.payments.claimTransfer(tx, { orderId: order.id, creatorUserId: order.creatorUserId, buyerUserId: command.actor.userId, requestId: command.requestId, at });
        if (claim.created) {
          await appendAdminAuditEvent(tx, { actorUserId: command.actor.userId, actorSessionId: command.actor.sessionId,
            subjectType: "commission_order", subjectId: order.id, action: "commission.transfer_claimed", outcome: "succeeded",
            beforeState: null, afterState: { claimId: claim.claimId }, assurance: { method: "current_session" }, applicationRevision: input.applicationRevision, requestId: command.requestId, occurredAt: at });
          await insertOutboxEvent(tx, { eventType: "commission.transfer_claimed.v1", eventVersion: 1, aggregateType: "commission_order", aggregateId: order.id,
            payload: { orderId: order.id, claimId: claim.claimId, buyerUserId: command.actor.userId, correlationId: command.requestId }, occurredAt: claim.claimedAt });
        }
        return { orderId: order.id, at, guardUntil: order.expiresAt! };
      });
    },
    ...createCommissionOrderMaintenanceService(input),
    ...createCommissionFulfillmentService({ mutate, owned, session, record, boundary, now, newId }, { ...input, completeCommissionOrder }),
    async getOrder(command: { actor: CommissionActor; orderId: string }) {
      actorValid(command.actor); if (!commissionUuid(command.orderId)) commissionFail("not_authorized");
      return boundary(() => input.db.transaction(async (tx) => {
        const candidate = await owned(tx, command.orderId, command.actor); await lockCommissionCreator(tx, candidate.creatorUserId); const proofExpiry = await session(tx, command.actor);
        const order = await owned(tx, command.orderId, command.actor);
        const [brief] = await tx.select().from(commissionBriefs).where(eq(commissionBriefs.orderId, order.id)).limit(1);
        const [revision] = await tx.select().from(commissionPackageRevisions).where(eq(commissionPackageRevisions.id, order.packageRevisionId)).limit(1);
        const [snapshot] = await tx.select().from(commissionTermsSnapshots).where(eq(commissionTermsSnapshots.orderId, order.id)).limit(1);
        const [quote] = order.currentQuoteId ? await tx.select().from(commissionQuoteRevisions).where(eq(commissionQuoteRevisions.id, order.currentQuoteId)).limit(1) : [];
        if (!brief || !revision) commissionFail("dependency_unavailable");
        const terms = snapshot ? decryptCommissionTerms(input.keyring, "commission_terms_snapshots", order.id, snapshot)
          : quote ? decryptCommissionTerms(input.keyring, "commission_quote_revisions", quote.id, quote) : revision.terms ? normalizeCommissionTerms(revision.terms) : null;
        const [policy] = await tx.select({ id: commissionPolicyRevisions.id, document: commissionPolicyRevisions.document, checksum: commissionPolicyRevisions.checksum })
          .from(commissionPolicyRevisions).where(eq(commissionPolicyRevisions.id, terms?.policyRevisionId ?? revision.policyRevisionId)).limit(1);
        const currentPolicy = order.creatorUserId === command.actor.userId ? await input.policy.readCurrent(tx, now()) : null;
        const canShowInstructions = order.buyerUserId === command.actor.userId && input.paymentsMode !== "disabled" && order.state === "awaiting_payment" &&
          await paymentsLifecycle.lockSettlement(tx, { orderId: order.id, creatorUserId: order.creatorUserId, at: now() });
        const payment = await input.payments.projectPayment(tx, { orderId: order.id, creatorUserId: order.creatorUserId, at: now(), includeInstructions: canShowInstructions });
        const role = order.buyerUserId === command.actor.userId ? "buyer" as const : "creator" as const;
        const referenceFiles = input.files ? await input.files.describeBriefFiles(tx, { orderId: order.id, viewer: role, withdrawn: order.state === "closed" }) : [];
        const completionDueAt = order.reviewEndsAt ? await readCommissionCompletionDueAt(tx, order.reviewEndsAt) : null;
        const at = now(); if (proofExpiry <= at) commissionFail("not_authorized");
        const effectivePayment = payment && payment.state === "awaiting_transfer" && new Date(payment.expiresAt) <= at
          ? { ...payment, state: "expired" as const, instruction: null } : payment;
        return { id: order.id, version: order.version, role,
          state: order.state as CommissionState, route: order.route, closeReason: order.closeReason, createdAt: order.createdAt.toISOString(), expiresAt: order.expiresAt?.toISOString() ?? null,
          acceptedAt: order.acceptedAt?.toISOString() ?? null, confirmedAt: order.confirmedAt?.toISOString() ?? null, dueAt: order.dueAt?.toISOString() ?? null,
          fulfillment: order.confirmedAt && snapshot ? { deliveredAt: order.deliveredAt?.toISOString() ?? null, reviewEndsAt: order.reviewEndsAt?.toISOString() ?? null,
            completionDueAt: completionDueAt?.toISOString() ?? null, completedAt: order.completedAt?.toISOString() ?? null, completionKind: order.completionKind,
            revisionsUsed: order.revisionsUsed, revisionAllowance: snapshot.revisionAllowance, lateDelivery: !!order.deliveredAt && !!order.dueAt && order.deliveredAt > order.dueAt,
            fileDeletionAt: order.completedAt ? commissionFileDeletionAt(order.completedAt).toISOString() : null } : null,
          overdue: !!order.dueAt && order.dueAt <= at, deadlinePassed: !!order.expiresAt && order.expiresAt <= at && ["requested", "quoted", "awaiting_payment"].includes(order.state),
          package: { id: order.packageId, revisionId: order.packageRevisionId, title: revision.title }, brief: decryptCommissionBrief(input.keyring, order.id, brief), referenceFiles,
          terms, policy: policy ?? null, currentPolicy: currentPolicy ? { revisionId: currentPolicy.revisionId, document: currentPolicy.document, acceptsOrders: currentPolicy.acceptsOrders } : null,
          quote: quote ? { id: quote.id, revisionNumber: quote.revisionNumber, issuedAt: quote.issuedAt.toISOString(), expiresAt: quote.expiresAt.toISOString() } : null, payment: effectivePayment };
      }));
    },
    async listQuoteHistory(command: { actor: CommissionActor; orderId: string; beforeRevision?: number; limit?: number }) {
      actorValid(command.actor); if (!commissionUuid(command.orderId)) commissionFail("not_authorized");
      const limit = commissionInteger(command.limit ?? 10, 1, 25);
      if (command.beforeRevision !== undefined) commissionInteger(command.beforeRevision, 1, 2_147_483_647);
      return boundary(() => input.db.transaction(async (tx) => {
        const proofExpiry = await session(tx, command.actor); const order = await owned(tx, command.orderId, command.actor);
        const rows = await tx.select().from(commissionQuoteRevisions).where(and(eq(commissionQuoteRevisions.orderId, order.id),
          command.beforeRevision === undefined ? undefined : lt(commissionQuoteRevisions.revisionNumber, command.beforeRevision)))
          .orderBy(desc(commissionQuoteRevisions.revisionNumber)).limit(limit + 1);
        const items = rows.slice(0, limit).map((row) => ({ id: row.id, revisionNumber: row.revisionNumber,
          issuedAt: row.issuedAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
          terms: decryptCommissionTerms(input.keyring, "commission_quote_revisions", row.id, row) }));
        if (proofExpiry <= now()) commissionFail("not_authorized");
        return { items, nextBeforeRevision: rows.length > limit ? items.at(-1)!.revisionNumber : null };
      }));
    },
    async listTimeline(command: { actor: CommissionActor; orderId: string; beforeVersion?: number; limit?: number }) {
      actorValid(command.actor); if (!commissionUuid(command.orderId)) commissionFail("not_authorized");
      const limit = commissionInteger(command.limit ?? 25, 1, 50);
      if (command.beforeVersion !== undefined) commissionInteger(command.beforeVersion, 1, 2_147_483_647);
      return boundary(() => input.db.transaction(async (tx) => {
        const proofExpiry = await session(tx, command.actor); const order = await owned(tx, command.orderId, command.actor);
        const rows = await tx.select({ version: commissionEvents.orderVersion, type: commissionEvents.type, reason: commissionEvents.reason,
          occurredAt: commissionEvents.occurredAt }).from(commissionEvents).where(and(eq(commissionEvents.orderId, order.id),
          command.beforeVersion === undefined ? undefined : lt(commissionEvents.orderVersion, command.beforeVersion)))
          .orderBy(desc(commissionEvents.orderVersion)).limit(limit + 1);
        const items = rows.slice(0, limit).map((row) => ({ ...row, occurredAt: row.occurredAt.toISOString() }));
        if (proofExpiry <= now()) commissionFail("not_authorized");
        return { items, nextBeforeVersion: rows.length > limit ? items.at(-1)!.version : null };
      }));
    },
    async listOrders(command: { actor: CommissionActor; role: "buyer" | "creator"; before?: { createdAt: string; id: string }; limit?: number }) {
      actorValid(command.actor); const limit = commissionInteger(command.limit ?? 25, 1, 50);
      if (command.role !== "buyer" && command.role !== "creator") commissionFail("invalid_request");
      const cursor = command.before;
      if (cursor && (!commissionUuid(cursor.id) || !Number.isFinite(Date.parse(cursor.createdAt)) || new Date(cursor.createdAt).toISOString() !== cursor.createdAt)) commissionFail("invalid_request");
      return boundary(() => input.db.transaction(async (tx) => {
        const proofExpiry = await session(tx, command.actor);
        const rows = await tx.select({ id: commissionOrders.id, state: commissionOrders.state, version: commissionOrders.version, route: commissionOrders.route,
          amountVnd: commissionOrders.amountVnd, createdAt: commissionOrders.createdAt, expiresAt: commissionOrders.expiresAt, dueAt: commissionOrders.dueAt, reviewEndsAt: commissionOrders.reviewEndsAt,
          title: commissionPackageRevisions.title }).from(commissionOrders).innerJoin(commissionPackageRevisions, eq(commissionPackageRevisions.id, commissionOrders.packageRevisionId))
          .where(and(eq(command.role === "buyer" ? commissionOrders.buyerUserId : commissionOrders.creatorUserId, command.actor.userId),
            cursor ? or(lt(commissionOrders.createdAt, new Date(cursor.createdAt)), and(eq(commissionOrders.createdAt, new Date(cursor.createdAt)), lt(commissionOrders.id, cursor.id))) : undefined))
          .orderBy(desc(commissionOrders.createdAt), desc(commissionOrders.id)).limit(limit + 1);
        const page = rows.slice(0, limit);
        const drafts = page.length ? await tx.select({ orderId: commissionSubmissions.orderId }).from(commissionSubmissions)
          .where(and(inArray(commissionSubmissions.orderId, page.map((row) => row.id)), eq(commissionSubmissions.kind, "draft"), isNull(commissionSubmissions.response))) : [];
        const awaiting = new Set(drafts.map((draft) => draft.orderId));
        const at = now(); if (proofExpiry <= at) commissionFail("not_authorized");
        const items = page.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt?.toISOString() ?? null, dueAt: row.dueAt?.toISOString() ?? null,
          reviewEndsAt: row.reviewEndsAt?.toISOString() ?? null, awaitingBuyer: row.state === "delivered" || awaiting.has(row.id), overdue: row.state === "in_progress" && !!row.dueAt && row.dueAt <= at }));
        const last = items.at(-1); return { items, nextBefore: rows.length > limit && last ? { id: last.id, createdAt: last.createdAt } : null };
      }));
    },
  };
}
export type CommissionOrderService = ReturnType<typeof createCommissionOrderService>;
