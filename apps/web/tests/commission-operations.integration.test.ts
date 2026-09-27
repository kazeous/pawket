import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { COMMISSION_POLICY, readCommissionOperationalReport } from "@pawket/orders";
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
    totpAuthMs: 300_000, assurance: paid.creator.assurance, commissions: paid.service.paymentsLifecycle });
  await confirm.confirm({ actor: paid.creator.actor, paymentIntentId: detail.payment!.id, observedAmountVnd: detail.payment!.amountVnd,
    observedTransferReference: detail.payment!.reference, observedBankTransactionId: randomUUID(), attestedReceived: true, ...commandIds() });
  const rows = async () => Promise.all([f.db.select().from(schema.commissionOrders), f.db.select().from(schema.commissionBriefs),
    f.db.select().from(schema.commissionQuoteRevisions), f.db.select().from(schema.commissionTermsSnapshots), f.db.select().from(schema.paymentIntents)]);
  const before = await rows(); const at = paid.creator.now();
  const initial = await readCommissionOperationalReport(f.db, at);
  expect(initial).toEqual({ requested: 1, quoted: 1, awaitingPayment: 1, inProgress: 1, expiredRequests: 0, expiredQuotes: 0, expiredPayments: 0,
    oldestExpiryLagSeconds: 0, overdue: 0, retentionUnacceptedClosed: 0, retentionAccepted: 2 });
  expect(await readCommissionOperationalReport(f.db, new Date(at.getTime() + 86_400_000))).toMatchObject({ expiredPayments: 1, expiredRequests: 0, oldestExpiryLagSeconds: 0 });
  expect(await readCommissionOperationalReport(f.db, new Date(at.getTime() + 7 * 86_400_000))).toMatchObject({ expiredRequests: 1, expiredQuotes: 1, overdue: 1 });
  expect(await readCommissionOperationalReport(f.db, new Date(at.getTime() + 90 * 86_400_000 - 1))).toMatchObject({ retentionUnacceptedClosed: 0 });
  expect(await readCommissionOperationalReport(f.db, new Date(at.getTime() + 90 * 86_400_000))).toMatchObject({ retentionUnacceptedClosed: 1, retentionAccepted: 2, oldestExpiryLagSeconds: 89 * 86_400 });
  expect(await rows()).toEqual(before);
  expect(JSON.stringify(initial)).not.toMatch(/Private|Envelope|orderId|reference|actorSession/);
});
