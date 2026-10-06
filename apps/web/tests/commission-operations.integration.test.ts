import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createCommissionThreadPort, encryptCommissionFileName } from "@pawket/commission-files";
import { COMMISSION_POLICY, createCommissionOrderMaintenanceService, createCommissionOrderService, readCommissionOperationalReport } from "@pawket/orders";
import { createCreatorCommissionPaymentService } from "@pawket/payments";
import { commandIds, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";
import { createCommissionOrderTestFixture } from "./commission-order-test-support.js";

const f = createCommissionOrderTestFixture("commission_operations");
beforeAll(f.initialize, 30_000); afterAll(f.dispose, 30_000);
test("aggregate expiry, overdue and retention reporting is read-only at exact boundaries", async () => {
  const request = await f.setup("fixed_approval"); const closedId = await request.service.request(request.request());
  await request.service.close({ actor: request.buyerActor, orderId: closedId, expectedVersion: 1, ...commandIds() });
  await request.service.request(request.request());
  const quote = await f.setup("custom_quote"); const quoteId = await quote.service.request(quote.request());
  await quote.service.quote({ actor: quote.creator.actor, orderId: quoteId, expectedVersion: 1, terms: quote.terms, ttlMs: COMMISSION_POLICY.defaultQuoteTtlMs, ...commandIds() });
  const payment = await f.setup(); await payment.service.request(payment.request());
  const paid = await f.setup(); const paidId = await paid.service.request(paid.request());
  const detail = await paid.service.getOrder({ actor: paid.buyerActor, orderId: paidId });
  const confirm = createCreatorCommissionPaymentService({ ...paid.creator.common, applicationRevision: "synthetic-i6", paymentsMode: "manual_only", recentAuthMs: 900_000,
    mfaAuthMs: 300_000, assurance: paid.creator.assurance, commissions: paid.service.paymentsLifecycle });
  await confirm.confirm({ actor: paid.creator.actor, paymentIntentId: detail.payment!.id, observedAmountVnd: detail.payment!.amountVnd,
    observedTransferReference: detail.payment!.reference, observedBankTransactionId: randomUUID(), attestedReceived: true, ...commandIds() });
  const rows = async () => Promise.all([f.db.select().from(schema.commissionOrders), f.db.select().from(schema.commissionBriefs),
    f.db.select().from(schema.commissionQuoteRevisions), f.db.select().from(schema.commissionTermsSnapshots), f.db.select().from(schema.paymentIntents)]);
  const before = await rows(); const at = paid.creator.now();
  const initial = await readCommissionOperationalReport(f.db, at);
  expect(initial).toEqual({ requested: 1, quoted: 1, awaitingPayment: 1, inProgress: 1, expiredRequests: 0, expiredQuotes: 0, expiredPayments: 0,
    delivered: 0, completed: 0, completedBuyer: 0, completedAutomatic: 0, completionBacklog: 0, lateDeliveries: 0, draftSubmissions: 0, finalSubmissions: 0,
    oldestExpiryLagSeconds: 0, overdue: 0, retentionUnacceptedClosed: 0, retentionAccepted: 2 });
  expect(await readCommissionOperationalReport(f.db, new Date(at.getTime() + 86_400_000))).toMatchObject({ expiredPayments: 1, expiredRequests: 0, oldestExpiryLagSeconds: 0 });
  expect(await readCommissionOperationalReport(f.db, new Date(at.getTime() + 7 * 86_400_000))).toMatchObject({ expiredRequests: 1, expiredQuotes: 1, overdue: 1 });
  expect(await readCommissionOperationalReport(f.db, new Date(at.getTime() + 90 * 86_400_000 - 1))).toMatchObject({ retentionUnacceptedClosed: 0 });
  expect(await readCommissionOperationalReport(f.db, new Date(at.getTime() + 90 * 86_400_000))).toMatchObject({ retentionUnacceptedClosed: 1, retentionAccepted: 2, oldestExpiryLagSeconds: 89 * 86_400 });
  expect(await rows()).toEqual(before);
  expect(JSON.stringify(initial)).not.toMatch(/Private|Envelope|orderId|reference|actorSession/);
});

test("report counts delivered, completed by kind, backlog, late deliveries and submissions", async () => {
  const DAY = 86_400_000;
  async function fulfill(p: Awaited<ReturnType<typeof f.paidOrder>>, kind: "draft" | "final") {
    const at = p.s.creator.now(); const id = randomUUID();
    const instance = createCommissionOrderService({ ...p.s.input, fulfillmentMode: "enabled", thread: createCommissionThreadPort({ keyring: p.s.input.keyring, mode: "enabled" }) });
    await f.db.insert(schema.commissionFiles).values({ id, ownerUserId: p.creator.userId, context: "submission", uploadOrderId: p.orderId, declaredBytes: 16,
      filenameEnvelope: encryptCommissionFileName(p.s.input.keyring, id, "Synthetic artwork"), objectKey: `commission/${id}`,
      uploadExpiresAt: new Date(at.getTime() + 900_000), requestId: "fixture", createdAt: at, updatedAt: at });
    await f.db.update(schema.commissionFiles).set({ state: "scanning", uploadedAt: at, scanDeadlineAt: new Date(at.getTime() + DAY), version: 2, updatedAt: at }).where(eq(schema.commissionFiles.id, id));
    await f.db.update(schema.commissionFiles).set({ state: "clean", sha256: `sha256:${"d".repeat(64)}`, detectedType: "png", quarantineVersionId: "q", cleanVersionId: "c", cleanAt: at, version: 3, updatedAt: at }).where(eq(schema.commissionFiles.id, id));
    const [order] = await f.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, p.orderId));
    await instance.submit({ actor: p.creator, orderId: p.orderId, expectedVersion: order!.version, kind, note: undefined, fileIds: [id], ...commandIds() });
    return instance;
  }
  const backlog = await f.paidOrder(); await fulfill(backlog, "final");
  const future = await f.paidOrder(); const at = new Date(future.s.creator.now().getTime() + 14 * DAY); future.s.creator.setNow(at); await fulfill(future, "final");
  const buyer = await f.paidOrder(); await fulfill(buyer, "draft"); const buyerService = await fulfill(buyer, "final");
  const finalSubmission = (await f.db.select().from(schema.commissionSubmissions).where(eq(schema.commissionSubmissions.orderId, buyer.orderId))).find((row) => row.kind === "final")!;
  await buyerService.respondToSubmission({ actor: buyer.buyer, orderId: buyer.orderId, submissionId: finalSubmission.id, expectedVersion: 3, response: "accept", note: undefined, ...commandIds() });
  const automatic = await f.paidOrder({ reviewWindowDays: 3 }); await fulfill(automatic, "final");
  const [autoOrder] = await f.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, automatic.orderId));
  automatic.s.creator.setNow(autoOrder!.reviewEndsAt!);
  expect(await createCommissionOrderMaintenanceService(automatic.s.input).completeDue()).toMatchObject({ completed: 1 });
  const rows = () => Promise.all([f.db.select().from(schema.commissionOrders), f.db.select().from(schema.commissionSubmissions),
    f.db.select().from(schema.commissionReservations), f.db.select().from(schema.paymentIntents), f.db.select().from(schema.commissionEvents), f.db.select().from(schema.systemOutbox)]);
  const before = await rows();
  const report = await readCommissionOperationalReport(f.db, at);
  expect(report).toMatchObject({ delivered: 2, completed: 2, completedBuyer: 1, completedAutomatic: 1,
    completionBacklog: 1, lateDeliveries: 1, draftSubmissions: 1, finalSubmissions: 4 });
  expect(await readCommissionOperationalReport(f.db, autoOrder!.reviewEndsAt!)).toMatchObject({ completionBacklog: 0 });
  expect(await rows()).toEqual(before);
  expect(JSON.stringify(report)).not.toMatch(/Envelope|orderId|filename|objectKey|note|url/iu);
});
