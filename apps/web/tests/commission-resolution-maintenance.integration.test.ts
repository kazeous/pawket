import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createCommissionResolutionOrderPort, lockCommissionCreator } from "@pawket/orders";
import { createCommissionPaymentFactsPort, createCommissionRefundPort, createCommissionRefundService } from "@pawket/payments";
import { createCommissionIntakeFencePort, createLateClaimService, createResolutionCommandKit, createResolutionMaintenance, effectiveResolutionDeadline } from "@pawket/resolutions";
import { createTrustCasePort } from "@pawket/trust";
import { createWorkerCommissionConfiguration } from "../../worker/src/commission-config.js";
import { createCommissionResolutionTestFixture, resolutions, submit } from "./commission-resolution-test-support.js";
import { commandIds, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";

const f = createCommissionResolutionTestFixture("i8maintenance");
beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);
const DAY = 86_400_000; const HOUR = 3_600_000;
type Paid = Awaited<ReturnType<typeof f.paidOrder>>;
const order = (p: Paid) => f.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, p.orderId)).then((rows) => rows[0]!);
function ports(p: Paid) {
  return { orders: createCommissionResolutionOrderPort({ applicationRevision: "synthetic-i8", newId: randomUUID }),
    refunds: createCommissionRefundPort({ keyring: p.s.input.keyring, calendarVersion: "vn-proposals-test" }),
    payments: createCommissionPaymentFactsPort(), cases: createTrustCasePort() };
}
const maintenance = (p: Paid, overrides: Partial<Parameters<typeof createResolutionMaintenance>[0]> = {}) =>
  createResolutionMaintenance({ db: f.db, ...ports(p), now: p.s.creator.now, ...overrides });
async function propose(p: Paid) {
  return resolutions(p).propose({ actor: p.buyer, orderId: p.orderId, expectedVersion: (await order(p)).version,
    kind: "cancel_with_refund", refundAmountVnd: 100_000, note: "Synthetic proposal", ...commandIds() });
}
async function refund(from?: Date) {
  const p = await f.paidOrder(); if (from) p.s.creator.setNow(from); const at = p.s.creator.now(); const port = ports(p).refunds;
  const { obligationId } = await f.db.transaction((tx) => port.createObligation(tx, { orderId: p.orderId,
    paymentIntentId: p.confirmationCommand.paymentIntentId, creatorUserId: p.creator.userId, buyerUserId: p.buyer.userId,
    source: "agreement", sourceId: randomUUID(), amountVnd: 100_000, requestId: randomUUID(), at }));
  const service = createCommissionRefundService({ ...p.s.creator.common, applicationRevision: "synthetic-i8", calendarVersion: "vn-proposals-test",
    mode: "enabled", recentAuthMs: 3_600_000, mfaAuthMs: 300_000, lockCreator: lockCommissionCreator, cases: ports(p).cases,
    assurance: { getTipSessionAssurance: async (_tx, _actor, time) => ({ primaryAuthenticatedAt: time, mfaEnrolled: false,
      mfaVerifiedAt: null, sessionExpiresAt: new Date(time.getTime() + 60_000) }) } });
  await service.enterDestination({ actor: p.buyer, obligationId, expectedVersion: 1, bankBin: "970422",
    accountNumber: "000000123456", accountHolder: "SYNTHETIC BUYER", ...commandIds() });
  const row = () => f.db.select().from(schema.commissionRefundObligations).where(eq(schema.commissionRefundObligations.id, obligationId)).then((rows) => rows[0]!);
  const send = async () => service.recordSend({ actor: p.creator, obligationId, expectedVersion: (await row()).version,
    transferDate: p.s.creator.now().toISOString().slice(0, 10), bankReference: "SYNTHETIC", ...commandIds() });
  return { p, obligationId, port, row, send };
}
const cases = (obligationId: string) => f.db.select().from(schema.trustCases).where(and(eq(schema.trustCases.sourceId, obligationId), eq(schema.trustCases.kind, "refund_overdue")));

test("scan expires a proposal after respond_by and restores review time", async () => {
  const p = await f.deliveredOrder(); const { proposalId } = await propose(p);
  const [proposal] = await f.db.select().from(schema.commissionProposals).where(eq(schema.commissionProposals.id, proposalId));
  p.s.creator.setNow(proposal!.respondBy); const result = await maintenance(p).scan({ limit: 500 });
  expect(result.expiredProposals).toBeGreaterThanOrEqual(1);
  expect((await order(p)).completionFloorAt).toEqual(new Date(p.s.creator.now().getTime() + proposal!.remainingReviewMs!));
  expect(await f.db.select({ state: schema.commissionProposals.state }).from(schema.commissionProposals).where(eq(schema.commissionProposals.id, proposalId))).toEqual([{ state: "expired" }]);
  expect((await maintenance(p).scan({ limit: 500 })).expiredProposals).toBe(0);
});
test("lapses a proposal whose order moved", async () => {
  const p = await f.paidOrder(); const { proposalId } = await propose(p);
  p.s.creator.setNow(new Date(p.s.creator.now().getTime() + 1)); await submit(p, "final");
  expect((await maintenance(p).scan({ limit: 500 })).lapsedProposals).toBeGreaterThanOrEqual(1);
  expect(await f.db.select({ state: schema.commissionProposals.state }).from(schema.commissionProposals).where(eq(schema.commissionProposals.id, proposalId))).toEqual([{ state: "lapsed" }]);
});
test("escalates an unanswered claim after five days", async () => {
  const s = await f.setup(); const orderId = await s.service.request(s.request());
  const [before] = await f.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, orderId));
  s.creator.setNow(before!.expiresAt!); await s.service.expireDue();
  const p = { s, orderId, buyer: s.buyerActor, creator: s.creator.actor };
  const kit = createResolutionCommandKit({ ...s.creator.common, session: s.input.identity });
  const { claimId } = await createLateClaimService(kit, { ...ports(p as Paid), mode: "enabled" }).fileLateClaim({ actor: p.buyer,
    orderId, transferAt: s.creator.now(), amountVnd: 100_000, bankReference: "SYNTHETIC", ...commandIds() });
  s.creator.setNow(new Date(s.creator.now().getTime() + 5 * DAY));
  expect((await maintenance(p as Paid).scan({ limit: 500 })).escalatedClaims).toBeGreaterThanOrEqual(1);
  expect(await f.db.select({ state: schema.commissionLatePaymentClaims.state }).from(schema.commissionLatePaymentClaims).where(eq(schema.commissionLatePaymentClaims.id, claimId))).toEqual([{ state: "escalated" }]);
  expect((await maintenance(p as Paid).scan({ limit: 500 })).escalatedClaims).toBe(0);
});
test("opens one refund_overdue case per overdue obligation and is idempotent", async () => {
  const c = await refund(); c.p.s.creator.setNow((await c.row()).dueAt!);
  expect((await maintenance(c.p).scan({ limit: 500 })).overdueCases).toBeGreaterThanOrEqual(1);
  expect((await maintenance(c.p).scan({ limit: 500 })).overdueCases).toBe(0); expect(await cases(c.obligationId)).toHaveLength(1);
});
test("presumes receipt after seven days", async () => {
  const c = await refund(); await c.send(); const deadline = (await c.row()).confirmBy!;
  c.p.s.creator.setNow(new Date(deadline.getTime() - 1)); await maintenance(c.p).scan({ limit: 500 }); expect((await c.row()).state).toBe("sent");
  c.p.s.creator.setNow(deadline); expect((await maintenance(c.p).scan({ limit: 500 })).presumedReceived).toBeGreaterThanOrEqual(1);
  expect((await c.row()).state).toBe("presumed_received");
});
test("purges destinations after 30 days, skips an open pause and uses plain retention time after resume", async () => {
  const c = await refund(); const m = maintenance(c.p); const at = c.p.s.creator.now();
  await f.db.transaction((tx) => c.port.waive(tx, { obligationId: c.obligationId, actor: null, requestId: randomUUID(), at }));
  c.p.s.creator.setNow(new Date(at.getTime() + 30 * DAY - 1)); await m.scan({ limit: 500 }); expect((await c.row()).destinationPurgedAt).toBeNull();
  await m.observeResolutionMode("disabled");
  try { c.p.s.creator.setNow(new Date(at.getTime() + 31 * DAY)); expect(await m.scan({ limit: 500 })).toEqual({ expiredProposals: 0, lapsedProposals: 0, escalatedClaims: 0, overdueCases: 0, presumedReceived: 0, purgedDestinations: 0 }); }
  finally { await m.observeResolutionMode("enabled"); }
  expect((await m.scan({ limit: 500 })).purgedDestinations).toBeGreaterThanOrEqual(1); expect((await c.row()).destinationPurgedAt).toEqual(c.p.s.creator.now());
});
test("resolution off then on around a refund deadline delays intake pause and case until resume plus 48 hours", async () => {
  const c = await refund(); const m = maintenance(c.p); const deadline = (await c.row()).dueAt!;
  const fence = (mode: "disabled" | "enabled") => createCommissionIntakeFencePort({ mode, refunds: c.port });
  const paused = (mode: "disabled" | "enabled") => f.db.transaction((tx) => fence(mode).isIntakePaused(tx, c.p.creator.userId, c.p.s.creator.now()));
  c.p.s.creator.setNow(new Date(deadline.getTime() - 1)); expect(await m.observeResolutionMode("disabled")).toEqual({ change: "opened", paused: true });
  try {
    c.p.s.creator.setNow(new Date(deadline.getTime() + DAY)); await m.scan({ limit: 500 }); expect(await paused("disabled")).toBe(false); expect(await paused("enabled")).toBe(false); expect(await cases(c.obligationId)).toHaveLength(0);
  } finally { await m.observeResolutionMode("enabled"); }
  const resumed = c.p.s.creator.now(); c.p.s.creator.setNow(new Date(resumed.getTime() + 48 * HOUR - 1));
  await m.scan({ limit: 500 }); expect(await paused("enabled")).toBe(false); expect(await cases(c.obligationId)).toHaveLength(0);
  c.p.s.creator.setNow(new Date(resumed.getTime() + 48 * HOUR)); await m.scan({ limit: 500 }); expect(await paused("enabled")).toBe(true); expect(await cases(c.obligationId)).toHaveLength(1);
  expect(await f.db.select().from(schema.commissionResolutionPauses).where(isNull(schema.commissionResolutionPauses.endedAt))).toHaveLength(0);
});
test("a send recorded just before the scan prevents the refund_overdue case, even with a stale candidate", async () => {
  const c = await refund(); c.p.s.creator.setNow((await c.row()).dueAt!);
  const candidates = await c.port.readOverdueCandidates(f.db, { at: c.p.s.creator.now(), limit: 500 });
  await c.send(); await maintenance(c.p, { refunds: { ...c.port, readOverdueCandidates: vi.fn(async () => candidates) } }).scan({ limit: 500 });
  expect(await cases(c.obligationId)).toHaveLength(0);
});
test("bounded scans advance beyond existing overdue cases and count current overdue obligations", async () => {
  const a = await refund(); const b = await refund(); const raw = (await a.row()).dueAt!; const at = (await f.db.transaction((tx) => effectiveResolutionDeadline(tx, raw)))!;
  a.p.s.creator.setNow(at); b.p.s.creator.setNow(at); const m = maintenance(a.p);
  for (let index = 0; index < 10; index++) await m.scan({ limit: 1 });
  expect(await cases(a.obligationId)).toHaveLength(1); expect(await cases(b.obligationId)).toHaveLength(1);
  const before = await m.readRefundOverdueCount(); expect(before).toBeGreaterThanOrEqual(2);
  await a.send(); expect(await m.readRefundOverdueCount()).toBe(before - 1);
});
test("bounded scans reach a stale proposal behind a proposal that is still awaiting a response", async () => {
  const a = await f.paidOrder(); await propose(a); const b = await f.paidOrder();
  b.s.creator.setNow(new Date(b.s.creator.now().getTime() + 1)); const { proposalId } = await propose(b);
  b.s.creator.setNow(new Date(b.s.creator.now().getTime() + 1)); await submit(b, "final"); const m = maintenance(b);
  for (let index = 0; index < 5; index++) await m.scan({ limit: 1 });
  expect(await f.db.select({ state: schema.commissionProposals.state }).from(schema.commissionProposals).where(eq(schema.commissionProposals.id, proposalId))).toEqual([{ state: "lapsed" }]);
});
test.each(["proposal", "claim", "confirmation"] as const)("%s uses effective resolution deadlines after a pause", async (kind) => {
  const from = new Date(Date.UTC(2027, ["proposal", "claim", "confirmation"].indexOf(kind), 1));
  const c = await refund(from); const p = c.p; const m = maintenance(p); let deadline: Date; let targetId: string;
  if (kind === "proposal") {
    const made = await propose(p); targetId = made.proposalId;
    const [row] = await f.db.select().from(schema.commissionProposals).where(eq(schema.commissionProposals.id, targetId)); deadline = row!.respondBy;
  } else if (kind === "confirmation") { await c.send(); deadline = (await c.row()).confirmBy!; targetId = c.obligationId; }
  else {
    const s = await f.setup(); const orderId = await s.service.request(s.request());
    s.creator.setNow(from); await s.service.expireDue();
    const late = createLateClaimService(createResolutionCommandKit({ ...s.creator.common, session: s.input.identity }), { ...ports({ ...p, s }), mode: "enabled" });
    const made = await late.fileLateClaim({ actor: s.buyerActor, orderId, transferAt: s.creator.now(), amountVnd: 100_000, bankReference: "SYNTHETIC", ...commandIds() }); targetId = made.claimId;
    const [row] = await f.db.select().from(schema.commissionLatePaymentClaims).where(eq(schema.commissionLatePaymentClaims.id, targetId)); deadline = row!.creatorRespondBy;
  }
  p.s.creator.setNow(new Date(deadline.getTime() - 1)); await m.observeResolutionMode("disabled");
  try { p.s.creator.setNow(new Date(deadline.getTime() + DAY)); await m.scan({ limit: 500 }); }
  finally { await m.observeResolutionMode("enabled"); }
  const readState = async () => kind === "proposal" ? (await f.db.select().from(schema.commissionProposals).where(eq(schema.commissionProposals.id, targetId)))[0]!.state
    : kind === "claim" ? (await f.db.select().from(schema.commissionLatePaymentClaims).where(eq(schema.commissionLatePaymentClaims.id, targetId)))[0]!.state : (await c.row()).state;
  const before = kind === "proposal" ? "pending" : kind === "claim" ? "awaiting_creator" : "sent";
  const resumed = p.s.creator.now(); p.s.creator.setNow(new Date(resumed.getTime() + 48 * HOUR - 1)); await m.scan({ limit: 500 }); expect(await readState()).toBe(before);
  p.s.creator.setNow(new Date(resumed.getTime() + 48 * HOUR)); await m.scan({ limit: 500 }); expect(await readState()).toBe(kind === "proposal" ? "expired" : kind === "claim" ? "escalated" : "presumed_received");
});
test("worker commission configuration holds automatic completion for a resolution proposal", async () => {
  const p = await f.deliveredOrder(); await propose(p); p.s.creator.setNow((await order(p)).reviewEndsAt!);
  const config = createWorkerCommissionConfiguration({ APP_REVISION: "synthetic-i8", PII_LOOKUP_HMAC_KEY: Buffer.alloc(32).toString("base64"),
    COMMISSION_PAYMENTS_MODE: "disabled", COMMISSION_FULFILLMENT_MODE: "enabled", COMMISSION_SCAN_BATCH_SIZE: 500, COMMISSION_SCAN_INTERVAL_MS: 5_000 }, p.s.input.keyring, {} as never);
  const result = await config.createService(f.db).completeDue({ limit: 500 });
  expect(result.held).toBeGreaterThanOrEqual(1); expect((await order(p)).state).toBe("delivered");
});
