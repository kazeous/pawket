import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createIdentityEnforcementPort } from "@pawket/identity";
import { createCommissionOrderService, createCommissionResolutionOrderPort, lockCommissionCreator } from "@pawket/orders";
import { createCommissionRefundPort } from "@pawket/payments";
import { createDisputeService, createResolutionCommandKit } from "@pawket/resolutions";
import { createPenaltyService, createTrustCasePort, createTrustRestrictionPort, type TrustRestriction } from "@pawket/trust";
import { commandIds, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";
import { createCommissionOrderTestFixture } from "./commission-order-test-support.js";

const f = createCommissionOrderTestFixture("restriction_races"); beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);
const deferred = () => Promise.withResolvers<void>();
test.each(["commission_buying", "dispute_opening"] as const)("%s racing enforcement commits first or is refused, on two real connections (20 iterations)", async (restriction: TrustRestriction) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const p = await f.paidOrder(); const commandFirst = iteration % 2 === 0; const entered = deferred(); const contender = deferred(); const release = deferred();
    let writerPid = 0; let readerPid = 0;
    const at = () => new Date();
    const { caseId } = await f.db.transaction((tx) => createTrustCasePort().openCase(tx, { kind: "dispute", orderId: p.orderId, sourceType: "commission_dispute", sourceId: randomUUID(), policyRevisionId: p.s.policyId, requestId: randomUUID(), at: at() }));
    const identity = createIdentityEnforcementPort({ clearPublishedHeadForSuspension: async () => ({ pageId: null, previousPublishedRevisionId: null }) });
    const penalties = createPenaltyService({ db: f.db, mode: "enabled", keyring: p.s.input.keyring, lookupHmacKey: p.s.input.lookupHmacKey, applicationRevision: "synthetic-race", fence: { lockCreatorFence: lockCommissionCreator },
      helpLinks: { async issue() { throw new Error("Restrictions must not issue help links"); } }, notices: { async queue() { throw new Error("Restrictions must not send notices"); } },
      identity: { ...identity, async lockSubject(tx, userId) {
        writerPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!.pid;
        if (commandFirst) contender.resolve();
        const subject = await identity.lockSubject(tx, userId);
        if (!commandFirst) { entered.resolve(); await release.promise; }
        return subject;
      } }, freeze: { freezeForRemoval: async () => ({ closedOrders: 0 }) }, policies: { readCurrentIds: async () => ({ enforcementRevisionId: null }) }, consumeStepUpProof: async () => true, now: at });
    const port = createTrustRestrictionPort({ mode: "enabled" });
    const restrictions = { async assertAllowed(tx: schema.PawketTransaction, c: Parameters<typeof port.assertAllowed>[1]) {
      readerPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!.pid;
      if (!commandFirst) contender.resolve();
      await port.assertAllowed(tx, c);
      if (commandFirst) { entered.resolve(); await release.promise; }
    } };
    const apply = async () => {
      const result = await penalties.apply({ owner: p.creator, stepUpProofId: randomUUID(), subjectUserId: p.buyer.userId, source: { caseId }, kind: "restriction", restriction, reasonCategory: "other", explanation: "Synthetic race", ...commandIds() });
      // Sample on the database after the enforcement transaction's COMMIT, never from its startsAt.
      const [committed] = await f.db.execute<{ at: Date }>(sql`select clock_timestamp() as at`);
      return { ...result, committedAt: new Date(committed!.at) };
    };
    const checkout = () => createCommissionOrderService({ ...p.s.input, restrictions, now: at }).request(p.s.request());
    const dispute = () => createDisputeService(createResolutionCommandKit({ ...p.s.creator.common, now: at, session: p.s.input.identity }), {
      orders: createCommissionResolutionOrderPort({ applicationRevision: "synthetic-race", newId: randomUUID }), refunds: createCommissionRefundPort({ keyring: p.s.input.keyring, calendarVersion: "unused" }),
      cases: createTrustCasePort(), mode: "enabled", restrictions,
    }).openDispute({ actor: p.buyer, orderId: p.orderId, expectedVersion: 2, reason: "not_delivered", statement: "Synthetic statement", requestedOutcome: { kind: "close", refundAmountVnd: 500_000 }, acknowledgeStaffReview: true, ...commandIds() });
    const command = restriction === "commission_buying" ? checkout : dispute;
    const first = (commandFirst ? command() : apply()).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    await entered.promise;
    const second = (commandFirst ? apply() : command()).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    try { await contender.promise; expect(writerPid).not.toBe(readerPid); }
    finally { release.resolve(); }
    const outcomes = await Promise.all([first, second]); const commandResult = outcomes[commandFirst ? 0 : 1]!; const writerResult = outcomes[commandFirst ? 1 : 0]!;
    expect(writerResult.ok).toBe(true);
    if (!commandFirst) { expect(commandResult).toMatchObject({ ok: false, error: { code: "not_available" } }); }
    else {
      expect(commandResult.ok).toBe(true);
      if (!commandResult.ok || !writerResult.ok) throw new Error("Expected both serialized commits");
      const committedAt = (writerResult.value as { committedAt: Date }).committedAt;
      if (restriction === "commission_buying") {
        const [row] = await f.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, commandResult.value as string)); expect(row!.createdAt.getTime()).toBeLessThanOrEqual(committedAt.getTime());
      } else {
        const [row] = await f.db.select().from(schema.commissionDisputes).where(eq(schema.commissionDisputes.id, (commandResult.value as { disputeId: string }).disputeId)); expect(row!.openedAt.getTime()).toBeLessThanOrEqual(committedAt.getTime());
      }
    }
  }
}, 120_000);
