import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createCommissionPackageService } from "@pawket/catalog";
import { commissionPolicyChecksum, createCommissionOrderService, createCommissionPolicyReadPort, type CommissionIntakeFencePort, type CommissionRoute } from "@pawket/orders";
import { createCommissionPaymentIntentPort, createCreatorCommissionPaymentService, createTipReceivingAccountEligibilityPort } from "@pawket/payments";
import { commandIds, createSePayIntegrationFixture, fixtureHash, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";

const at = new Date("2026-09-26T04:00:00Z");
type SetupOptions = { revisionAllowance?: number; reviewWindowDays?: number; intakeFence?: CommissionIntakeFencePort };
export function createCommissionOrderTestFixture(label: string) {
  const parsed = new URL(process.env.TEST_DATABASE_URL ?? "invalid:");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) throw new Error("Commission workflow tests require a dedicated local test database");
  const base = createSePayIntegrationFixture(label); const policyId = randomUUID();
  async function initialize() {
    await base.initialize();
    const facts = { technicalVersion: "commission-v1", minimumVnd: 50_000, maximumVnd: 50_000_000, approvalKind: "synthetic", document: "Synthetic local policy; not approved for live payments." };
    await base.db.insert(schema.commissionPolicyRevisions).values({ id: policyId, revisionNumber: 2, ...facts, source: "synthetic-workflow-test",
      checksum: commissionPolicyChecksum(facts), effectiveAt: at, createdAt: at });
    await base.db.update(schema.commissionPolicyCurrent).set({ revisionId: policyId, updatedAt: at });
  }
  async function setup(route: CommissionRoute = "fixed_immediate", options: SetupOptions = {}) {
    const creator = await base.creator(); creator.setNow(at);
    const users = new Map([[creator.actor.userId, creator.actor.sessionId]]); const gates = { eligible: true, visible: true };
    async function buyer() {
      const userId = `i6-buyer-${randomUUID()}`; const sessionId = `i6-session-${randomUUID()}`;
      await base.db.insert(schema.identityUsers).values({ id: userId, name: "Synthetic buyer", email: `${userId}@example.invalid`, canonicalEmail: `${userId}@example.invalid`, createdAt: at, updatedAt: at });
      users.set(userId, sessionId); return { userId, sessionId };
    }
    const buyerActor = await buyer(); const pageId = randomUUID(); const publicationId = randomUUID(); const handle = `artist-${randomUUID().slice(0, 8)}`;
    await base.db.insert(schema.creatorPages).values({ id: pageId, userId: creator.actor.userId, initializedFromRevisionId: randomUUID(), createdAt: at, updatedAt: at });
    await base.db.insert(schema.creatorPublicationRevisions).values({ id: publicationId, pageId, revisionNumber: 1, canonicalHandle: handle, displayName: "Artist", shortIntroduction: "Art",
      primaryDiscipline: "illustration", secondaryDisciplines: [], actorUserId: creator.actor.userId, actorSessionId: creator.actor.sessionId, expectedDraftVersion: 1, requestId: randomUUID(), publishedAt: at });
    await base.db.update(schema.creatorPages).set({ publishedRevisionId: publicationId }).where(eq(schema.creatorPages.id, pageId));
    await base.db.insert(schema.creatorHandleClaims).values({ id: randomUUID(), pageId, normalizedHandle: handle, kind: "canonical", claimedAt: at });
    const policy = createCommissionPolicyReadPort({ environment: "test" });
    const identity = { getTipSessionAssurance: async (_tx: unknown, actor: { userId: string; sessionId: string }, time: Date) => users.get(actor.userId) === actor.sessionId
      ? { sessionExpiresAt: new Date(time.getTime() + 60_000) } : null,
    lockSettlementParticipants: async (_tx: unknown, command: { buyerUserId: string; creatorUserId: string }) => gates.eligible && users.has(command.buyerUserId) && command.creatorUserId === creator.actor.userId };
    const catalog = createCommissionPackageService({ ...creator.common, applicationRevision: "synthetic-i6", intakeMode: "enabled", paymentsMode: "manual_only", publishingMode: "general_audience", policy, intakeFence: options.intakeFence,
      identity: { lockCreator: async (tx, actor, time) => actor.userId === creator.actor.userId ? identity.getTipSessionAssurance(tx, actor, time) : null },
      receivingAccount: createTipReceivingAccountEligibilityPort({ ...creator.common, paymentsMode: "manual_only" }),
      visibility: { resolveVisibleReportTarget: async (_tx, target) => gates.visible ? { target, pageId, creatorUserId: creator.actor.userId, canonicalHandle: handle,
        displayName: "Artist", showcaseTitle: null, mediaAssetIds: [] } : null },
    });
    const terms = { amountVnd: 500_000, turnaroundDays: 7, revisionAllowance: options.revisionAllowance ?? 2, reviewWindowDays: options.reviewWindowDays ?? 7, scope: "Portrait", deliverables: "PNG", usageRights: "Personal", artistTerms: "Public artist terms", policyRevisionId: policyId };
    const draft = { title: "Portrait", description: "One portrait", discipline: "illustration", route, briefInstructions: "Describe your idea", terms: route === "custom_quote" ? null : terms, showcaseId: null };
    const packageId = await catalog.saveDraft({ actor: creator.actor, pageId, packageId: null, expectedVersion: 0, draft, ...commandIds() });
    await catalog.changePackage({ actor: creator.actor, packageId, expectedVersion: 1, action: "publish", policyRevisionId: policyId, ...commandIds() });
    await catalog.saveSettings({ actor: creator.actor, expectedVersion: 0, enabled: true, capacityLimit: 3, ...commandIds() });
    const [pkg] = await base.db.select().from(schema.commissionPackages).where(eq(schema.commissionPackages.id, packageId));
    const payments = createCommissionPaymentIntentPort({ ...creator.common, paymentsMode: "manual_only" });
    const input: Parameters<typeof createCommissionOrderService>[0] = { ...creator.common, applicationRevision: "synthetic-i6", intakeMode: "enabled", paymentsMode: "manual_only", identity, catalog, payments, policy,
      fulfillmentMode: "disabled",
      trust: { lockCommissionPage: async () => true } };
    const service = createCommissionOrderService(input);
    const request = (actor = buyerActor) => ({ actor, packageId, revisionId: pkg!.publishedRevisionId!, policyRevisionId: policyId, acceptTerms: route !== "custom_quote",
      brief: { text: "Private commission brief", referenceLinks: ["https://example.invalid/reference"] }, abuseKeyHash: fixtureHash(), ...commandIds() });
    return { creator, buyerActor, buyer, gates, users, catalog, input, service, payments, terms, draft, pageId, handle, packageId, revisionId: pkg!.publishedRevisionId!, policyId, request };
  }
  async function paidOrder(options: SetupOptions = {}) {
    const s = await setup("fixed_immediate", options);
    const orderId = await s.service.request(s.request()); s.creator.advance(1_000);
    const order = await s.service.getOrder({ actor: s.buyerActor, orderId });
    if (!order.payment) throw new Error("Synthetic commission payment missing");
    // Payments owns one db.transaction and calls lockSettlement and confirmPayment on this lifecycle port.
    const payments = createCreatorCommissionPaymentService({ ...s.creator.common, applicationRevision: "synthetic-i7", paymentsMode: "manual_only",
      recentAuthMs: 900_000, mfaAuthMs: 300_000, assurance: s.creator.assurance, commissions: s.service.paymentsLifecycle });
    const confirmationCommand = { actor: s.creator.actor, paymentIntentId: order.payment.id, observedAmountVnd: order.payment.amountVnd,
      observedTransferReference: order.payment.reference, observedBankTransactionId: randomUUID(), attestedReceived: true, ...commandIds() };
    await payments.confirm(confirmationCommand);
    return { orderId, service: s.service, buyer: s.buyerActor, creator: s.creator.actor, s, confirmationCommand, confirmationService: payments };
  }
  return { ...base, initialize, setup, paidOrder, policyId };
}
