import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createCommissionResolutionOrderPort, lockCommissionCreator } from "@pawket/orders";
import { createCommissionPaymentFactsPort, createCommissionRefundPort, createCommissionRefundService } from "@pawket/payments";
import * as resolution from "@pawket/resolutions";
import { createTrustCasePort } from "@pawket/trust";
import { createCommissionResolutionTestFixture } from "./commission-resolution-test-support.js";
import { commandIds, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";

const f = createCommissionResolutionTestFixture("i8late");
beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);
const DAY = 86_400_000; const calendarVersion = "vn-proposals-test";
type Context = Readonly<{ s: Awaited<ReturnType<typeof f.setup>>; orderId: string; buyer: { userId: string; sessionId: string }; creator: { userId: string; sessionId: string } }>;
const order = (p: Context) => f.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, p.orderId)).then((rows) => rows[0]!);
const claims = (p: Context) => f.db.select().from(schema.commissionLatePaymentClaims).where(eq(schema.commissionLatePaymentClaims.orderId, p.orderId));
const refunds = (p: Context) => f.db.select().from(schema.commissionRefundObligations).where(eq(schema.commissionRefundObligations.orderId, p.orderId));
const cases = (p: Context) => f.db.select().from(schema.trustCases).where(eq(schema.trustCases.orderId, p.orderId));
const outbox = (claimId: string) => f.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.aggregateId, claimId));
const orderPort = () => createCommissionResolutionOrderPort({ applicationRevision: "synthetic-i8", newId: randomUUID });
function ports(p: Context) {
  return { orders: orderPort(), refunds: createCommissionRefundPort({ keyring: p.s.input.keyring, calendarVersion }),
    payments: createCommissionPaymentFactsPort(), cases: createTrustCasePort(), mode: "enabled" as const };
}
function kit(p: Context, options: Partial<Parameters<typeof resolution.createResolutionCommandKit>[0]> = {}) {
  return resolution.createResolutionCommandKit({ ...p.s.creator.common, session: p.s.input.identity, ...options });
}
function service(p: Context, options: Partial<Parameters<typeof resolution.createLateClaimService>[1]> = {}, kitOptions: Partial<Parameters<typeof resolution.createResolutionCommandKit>[0]> = {}) {
  return resolution.createLateClaimService(kit(p, kitOptions), { ...ports(p), ...options });
}
async function closedOrder(reason: "payment_expired" | "buyer_cancelled" | "creator_cancelled" = "payment_expired") {
  const s = await f.setup(); const orderId = await s.service.request(s.request());
  const p = { s, orderId, buyer: s.buyerActor, creator: s.creator.actor };
  if (reason === "payment_expired") { s.creator.setNow((await order(p)).expiresAt!); await s.service.expireDue(); }
  else await s.service.close({ actor: reason === "buyer_cancelled" ? p.buyer : p.creator, orderId, expectedVersion: 1, ...commandIds() });
  expect(await order(p)).toMatchObject({ state: "closed", closeReason: reason }); return p;
}
const filing = (p: Context) => ({ actor: p.buyer, orderId: p.orderId, transferAt: p.s.creator.now(), amountVnd: 500_000,
  bankReference: "SYNTHETIC_REF", note: "Synthetic private claim note", ...commandIds() });
const answer = (p: Context, claimId: string, received = true) => ({ actor: p.creator, claimId, received,
  ...(received ? { receivedAmountVnd: 480_000 } : {}), ...commandIds() });
async function unchangedFacts(p: Context) {
  return { order: await order(p), intents: await f.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.commissionOrderId, p.orderId)),
    reservations: await f.db.select().from(schema.commissionReservations).where(eq(schema.commissionReservations.orderId, p.orderId)),
    events: await f.db.select().from(schema.commissionEvents).where(eq(schema.commissionEvents.orderId, p.orderId)) };
}
function view(p: Context, lateClaims = service(p)) {
  const partyRefunds = createCommissionRefundService({ ...p.s.creator.common, applicationRevision: "synthetic-i8", calendarVersion,
    mode: "enabled", recentAuthMs: 3_600_000, mfaAuthMs: 300_000, lockCreator: lockCommissionCreator,
    assurance: { getTipSessionAssurance: async (_tx, actor, at) => p.s.users.get(actor.userId) === actor.sessionId
      ? { primaryAuthenticatedAt: at, mfaEnrolled: false, mfaVerifiedAt: null, sessionExpiresAt: new Date(at.getTime() + 60_000) } : null } });
  return resolution.createResolutionViewService({ db: f.db, keyring: p.s.input.keyring,
    orders: { ...orderPort(), listOrders: p.s.service.listOrders }, refunds: partyRefunds, session: p.s.input.identity, now: p.s.creator.now, lateClaims });
}
async function escalated() {
  const p = await closedOrder(); const instance = service(p); const { claimId } = await instance.fileLateClaim(filing(p));
  await instance.answerLateClaim(answer(p, claimId, false));
  const owner = await p.s.buyer(); const consume = vi.fn(async (_tx: unknown, command: { userId: string; sessionId: string }) => command.userId === owner.userId && command.sessionId === owner.sessionId);
  const ownerService = resolution.createOwnerResolutionService(kit(p, { consumeStepUpProof: consume }), { ...ports(p), applicationRevision: "synthetic-i8" });
  return { p, instance, claimId, owner, consume, ownerService };
}
const provider = async (p: Context, providerEventId: string = randomUUID()) => ({ orderId: p.orderId,
  paymentIntentId: (await f.db.transaction((tx) => ports(p).payments.closedIntent(tx, p.orderId)))!.paymentIntentId,
  amountVnd: 500_000, providerEventId, at: p.s.creator.now(), requestId: randomUUID() });

describe("commission late-payment claims", () => {
  test.each([29, 30, 31])("a payment_expired close %i days ago respects the 30-day filing boundary", async (days) => {
    const p = await closedOrder(); p.s.creator.advance(days * DAY);
    if (days <= 30) expect(await service(p).fileLateClaim(filing(p))).toEqual({ claimId: expect.any(String) });
    else { await expect(service(p).fileLateClaim(filing(p))).rejects.toMatchObject({ code: "deadline_passed" }); expect(await claims(p)).toHaveLength(0); }
  });
  test.each(["buyer_cancelled", "creator_cancelled"] as const)("%s after an intent was issued is eligible", async (reason) => {
    const p = await closedOrder(reason); await service(p).fileLateClaim(filing(p)); expect(await claims(p)).toHaveLength(1);
  });
  test.each(["fixed_approval", "custom_quote"] as const)("%s closes without an intent are invalid_transition", async (route) => {
    const s = await f.setup(route); const orderId = await s.service.request(s.request());
    if (route === "custom_quote") await s.service.quote({ actor: s.creator.actor, orderId, expectedVersion: 1, terms: s.terms, ttlMs: DAY, ...commandIds() });
    const p = { s, orderId, buyer: s.buyerActor, creator: s.creator.actor };
    await s.service.close({ actor: p.buyer, orderId, expectedVersion: (await order(p)).version, ...commandIds() });
    await expect(service(p).fileLateClaim(filing(p))).rejects.toMatchObject({ code: "invalid_transition" }); expect(await claims(p)).toHaveLength(0);
  });
  test("a paid close and a live awaiting_payment order are invalid_transition", async () => {
    const paid = await f.paidOrder(); const instance = orderPort();
    await f.db.transaction((tx) => instance.closePaidOrder(tx, { orderId: paid.orderId, expectedVersion: 2, reason: "cancelled_by_agreement", actor: paid.buyer, requestId: randomUUID(), at: paid.s.creator.now() }));
    await expect(service(paid).fileLateClaim(filing(paid))).rejects.toMatchObject({ code: "invalid_transition" });
    const s = await f.setup(); const orderId = await s.service.request(s.request()); const p = { s, orderId, buyer: s.buyerActor, creator: s.creator.actor };
    await expect(service(p).fileLateClaim(filing(p))).rejects.toMatchObject({ code: "invalid_transition" });
  });
  test("filing replays once, binds the target, encrypts private fields and refuses a second claim", async () => {
    const p = await closedOrder(); const instance = service(p); const command = filing(p); const result = await instance.fileLateClaim(command);
    p.s.creator.advance(1); expect(await instance.fileLateClaim(command)).toEqual(result);
    await expect(instance.fileLateClaim({ ...filing(p), transferAt: command.transferAt })).rejects.toMatchObject({ code: "invalid_transition" });
    const otherId = await p.s.service.request(p.s.request());
    await expect(instance.fileLateClaim({ ...command, orderId: otherId })).rejects.toMatchObject({ code: "idempotency_conflict" });
    const rows = await claims(p); expect(rows).toHaveLength(1);
    for (const text of [command.bankReference, command.note]) expect(JSON.stringify(rows).includes(text)).toBe(false);
    const decrypt = kit(p); expect(decrypt.decrypt("commission_late_payment_claims", result.claimId, "bank_reference", rows[0]!.referenceEnvelope) === command.bankReference).toBe(true);
    expect(() => decrypt.decrypt("commission_late_payment_claims", randomUUID(), "bank_reference", rows[0]!.referenceEnvelope)).toThrow();
    expect((await outbox(result.claimId)).map((event) => event.payload)).toEqual([{ claimId: result.claimId, orderId: p.orderId }]);
  });
  test("creator received 480,000 creates a late_payment obligation and keeps all order/payment/slot facts unchanged", async () => {
    const p = await closedOrder(); const before = await unchangedFacts(p); const instance = service(p); const { claimId } = await instance.fileLateClaim(filing(p));
    const command = answer(p, claimId); const result = await instance.answerLateClaim(command);
    expect(await instance.answerLateClaim(command)).toEqual(result);
    await expect(instance.answerLateClaim(answer(p, claimId))).rejects.toMatchObject({ code: "invalid_transition" });
    expect(await claims(p)).toMatchObject([{ state: "refund_owed", receivedAmountVnd: 480_000, version: 2, endedAt: p.s.creator.now() }]);
    expect(await refunds(p)).toMatchObject([{ source: "late_payment", sourceId: claimId, amountVnd: 480_000, state: "awaiting_destination" }]);
    expect(await unchangedFacts(p)).toEqual(before); expect(await cases(p)).toHaveLength(0);
    expect((await outbox(claimId)).map((event) => event.payload)).toEqual([{ claimId, orderId: p.orderId }, { claimId, orderId: p.orderId, state: "refund_owed" }]);
  });
  test("not received escalates and opens one late_payment case, atomically and idempotently", async () => {
    const p = await closedOrder(); const instance = service(p); const { claimId } = await instance.fileLateClaim(filing(p)); const command = answer(p, claimId, false);
    const result = await instance.answerLateClaim(command); expect(await instance.answerLateClaim(command)).toEqual(result);
    expect(await claims(p)).toMatchObject([{ state: "escalated", endedAt: null, receivedAmountVnd: null, version: 2 }]); expect(await refunds(p)).toHaveLength(0);
    expect(await cases(p)).toMatchObject([{ kind: "late_payment", sourceType: "commission_late_payment_claim", sourceId: claimId, state: "open", policyRevisionId: p.s.policyId }]);
  });
  test.each(["refund_owed", "rejected"] as const)("owner rules %s, resolves the case, audits and replays before consuming proof", async (outcome) => {
    const c = await escalated(); const before = await unchangedFacts(c.p); const command = { owner: c.owner, stepUpProofId: randomUUID(), claimId: c.claimId,
      outcome, ...(outcome === "refund_owed" ? { amountVnd: 470_000 } : {}), reason: "Synthetic owner claim reason", ...commandIds() };
    const result = await c.ownerService.ruleLateClaim(command); c.consume.mockResolvedValue(false);
    expect(await c.ownerService.ruleLateClaim(command)).toEqual(result); expect(c.consume).toHaveBeenCalledTimes(1);
    expect(c.consume).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ...c.owner, actionClass: "owner.case_rule_claim" }));
    expect(await claims(c.p)).toMatchObject([{ state: outcome, receivedAmountVnd: outcome === "refund_owed" ? 470_000 : null, version: 3 }]);
    expect(await cases(c.p)).toMatchObject([{ state: "resolved", resolutionKind: outcome }]);
    const obligations = await refunds(c.p);
    if (outcome === "refund_owed") expect(obligations).toMatchObject([{ source: "late_payment", sourceId: c.claimId, amountVnd: 470_000 }]); else expect(obligations).toHaveLength(0);
    const audits = await f.db.select().from(schema.adminAuditEvents).where(eq(schema.adminAuditEvents.requestId, command.requestId)); expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "owner.case_rule_claim", actorUserId: c.owner.userId, actorSessionId: c.owner.sessionId,
      subjectType: "commission_late_payment_claim", subjectId: c.claimId, applicationRevision: "synthetic-i8", assurance: { method: "owner_step_up" }, beforeState: { state: "escalated" }, afterState: { state: outcome } });
    expect(JSON.stringify(audits).includes(command.reason)).toBe(false); expect(await unchangedFacts(c.p)).toEqual(before);
    await expect(c.ownerService.ruleLateClaim({ ...command, ...commandIds() })).rejects.toMatchObject({ code: "owner_step_up_required" });
  });
  test("owner can only rule an escalated claim with an open case, valid amount and a usable proof", async () => {
    const c = await escalated(); const base = { owner: c.owner, stepUpProofId: randomUUID(), claimId: c.claimId, reason: "Synthetic reason", ...commandIds() };
    for (const amountVnd of [undefined, 0, 50_000_001]) await expect(c.ownerService.ruleLateClaim({ ...base, outcome: "refund_owed", amountVnd })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(c.ownerService.ruleLateClaim({ ...base, outcome: "rejected", amountVnd: 1 })).rejects.toMatchObject({ code: "invalid_request" });
    const pending = await closedOrder(); const { claimId } = await service(pending).fileLateClaim(filing(pending));
    await expect(c.ownerService.ruleLateClaim({ ...base, claimId, outcome: "rejected" })).rejects.toMatchObject({ code: "invalid_transition" });
    expect(await claims(c.p)).toMatchObject([{ state: "escalated" }]); expect(await refunds(c.p)).toHaveLength(0);
  });
  test.each(["none", "awaiting_creator", "escalated"] as const)("provider evidence creates one obligation and settles an %s claim", async (state) => {
    const p = await closedOrder(); const instance = service(p); const before = await unchangedFacts(p); let claimId: string | undefined;
    if (state !== "none") { ({ claimId } = await instance.fileLateClaim(filing(p))); if (state === "escalated") await instance.answerLateClaim(answer(p, claimId, false)); }
    const command = await provider(p);
    const results = await Promise.all([1, 2].map(() => f.db.transaction((tx) => instance.recordProviderLatePayment(tx, command))));
    expect(results.sort()).toEqual(["already_recorded", "obligation_created"]);
    expect(await refunds(p)).toMatchObject([{ source: "late_payment_provider", sourceId: command.providerEventId, amountVnd: 500_000 }]); expect(await refunds(p)).toHaveLength(1);
    if (claimId) expect(await claims(p)).toMatchObject([{ state: "refund_owed", receivedAmountVnd: 500_000 }]);
    if (state === "escalated") expect(await cases(p)).toMatchObject([{ state: "resolved", resolutionKind: "refund_owed" }]);
    expect(await unchangedFacts(p)).toEqual(before);
  });
  test("numeric provider event IDs derive stable UUID source IDs across instances", async () => {
    const p = await closedOrder(); const command = await provider(p, "12345678901234567890123456789012");
    expect(await f.db.transaction((tx) => service(p).recordProviderLatePayment(tx, command))).toBe("obligation_created");
    expect(await f.db.transaction((tx) => service(p).recordProviderLatePayment(tx, { ...command, requestId: randomUUID() }))).toBe("already_recorded");
    expect(await refunds(p)).toHaveLength(1); expect((await refunds(p))[0]!.sourceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });
  test("provider hook refuses mismatched intent/amount and paid orders", async () => {
    const p = await closedOrder(); const command = await provider(p); const instance = service(p);
    for (const change of [{ paymentIntentId: randomUUID() }, { amountVnd: 499_999 }]) expect(await f.db.transaction((tx) => instance.recordProviderLatePayment(tx, { ...command, ...change }))).toBe("not_applicable");
    const paid = await f.paidOrder(); expect(await f.db.transaction((tx) => service(paid).recordProviderLatePayment(tx, { ...command, orderId: paid.orderId }))).toBe("not_applicable");
    expect(await refunds(p)).toHaveLength(0); expect(await claims(p)).toHaveLength(0);
  });
  test("maintenance escalates only at the effective deadline, refreshes stale candidates and does nothing while disabled", async () => {
    const p = await closedOrder(); const instance = service(p); await instance.fileLateClaim(filing(p)); const [row] = await claims(p); const pauseId = randomUUID();
    const startedAt = new Date(row!.creatorRespondBy.getTime() - 1); await f.db.insert(schema.commissionResolutionPauses).values({ id: pauseId, startedAt });
    const endedAt = new Date(row!.creatorRespondBy.getTime() + DAY);
    try {
      p.s.creator.setNow(endedAt); await f.db.transaction((tx) => instance.escalateUnanswered(tx, row!, endedAt, randomUUID()));
      expect(await claims(p)).toMatchObject([{ state: "awaiting_creator" }]); expect(await cases(p)).toHaveLength(0);
    } finally { await f.db.update(schema.commissionResolutionPauses).set({ endedAt, version: 2 }).where(eq(schema.commissionResolutionPauses.id, pauseId)); }
    const due = new Date(endedAt.getTime() + resolution.RESOLUTION_POLICY.pauseGraceMs);
    p.s.creator.setNow(new Date(due.getTime() - 1)); await f.db.transaction((tx) => instance.escalateUnanswered(tx, row!, p.s.creator.now(), randomUUID())); expect(await cases(p)).toHaveLength(0);
    p.s.creator.setNow(due); await f.db.transaction((tx) => service(p, { mode: "disabled" }).escalateUnanswered(tx, row!, due, randomUUID())); expect(await cases(p)).toHaveLength(0);
    await f.db.transaction((tx) => instance.escalateUnanswered(tx, row!, due, randomUUID()));
    await f.db.transaction((tx) => instance.escalateUnanswered(tx, row!, due, randomUUID()));
    expect(await claims(p)).toMatchObject([{ state: "escalated", version: 2 }]); expect(await cases(p)).toHaveLength(1);
  });
  test("creator answers only before the effective deadline; a commit crossing it rolls back", async () => {
    const p = await closedOrder(); const instance = service(p); const { claimId } = await instance.fileLateClaim(filing(p)); const [row] = await claims(p);
    const due = (await f.db.transaction((tx) => resolution.effectiveResolutionDeadline(tx, row!.creatorRespondBy)))!;
    p.s.creator.setNow(due); await expect(instance.answerLateClaim(answer(p, claimId))).rejects.toMatchObject({ code: "deadline_passed" });
    p.s.creator.setNow(new Date(due.getTime() - 1));
    const refundsPort = ports(p).refunds; const create = refundsPort.createObligation;
    vi.spyOn(refundsPort, "createObligation").mockImplementation(async (tx, command) => { const result = await create(tx, command); p.s.creator.advance(1); return result; });
    await expect(service(p, { refunds: refundsPort }).answerLateClaim(answer(p, claimId))).rejects.toMatchObject({ code: "deadline_passed" });
    expect(await claims(p)).toMatchObject([{ state: "awaiting_creator", version: 1 }]); expect(await refunds(p)).toHaveLength(0);
  });
  test("buyer and creator resolution views and my cases include the claim; outsiders cannot read it", async () => {
    const p = await closedOrder(); const instance = service(p); const command = filing(p); const { claimId } = await instance.fileLateClaim(command); const views = view(p, instance);
    for (const actor of [p.buyer, p.creator]) {
      const projected = (await views.getOrderResolution({ actor, orderId: p.orderId })).lateClaim;
      expect(projected).toMatchObject({ id: claimId, state: "awaiting_creator", claimedAmountVnd: 500_000 });
      expect(projected?.bankReference === command.bankReference && projected?.note === command.note).toBe(true);
      expect((await views.listMyCases({ actor })).lateClaims).toMatchObject([{ id: claimId, orderId: p.orderId, state: "awaiting_creator" }]);
    }
    const outsider = await p.s.buyer(); await expect(views.getOrderResolution({ actor: outsider, orderId: p.orderId })).rejects.toMatchObject({ code: "not_available" });
    expect((await views.listMyCases({ actor: outsider })).lateClaims).toHaveLength(0);
    await instance.answerLateClaim(answer(p, claimId)); expect((await views.getOrderResolution({ actor: p.buyer, orderId: p.orderId })).lateClaim).toMatchObject({ state: "refund_owed", receivedAmountVnd: 480_000 });
  });
  test("commands enforce participants, session, switch, amount, time and file port boundaries", async () => {
    const p = await closedOrder(); const instance = service(p); const command = filing(p); const outsider = await p.s.buyer();
    for (const actor of [p.creator, outsider]) await expect(instance.fileLateClaim({ ...command, actor })).rejects.toMatchObject({ code: "not_available" });
    await expect(instance.fileLateClaim({ ...command, actor: { ...p.buyer, sessionId: randomUUID() } })).rejects.toMatchObject({ code: "not_authorized" });
    await expect(service(p, { mode: "disabled" }).fileLateClaim(command)).rejects.toMatchObject({ code: "resolution_disabled" });
    for (const change of [{ amountVnd: 0 }, { amountVnd: 50_000_001 }, { transferAt: new Date(p.s.creator.now().getTime() + 1) }, { bankReference: "bad ref" }, { fileIds: [] }, { fileIds: [randomUUID()] }])
      await expect(instance.fileLateClaim({ ...command, ...change })).rejects.toMatchObject({ code: "invalid_request" });
    const { claimId } = await instance.fileLateClaim(command);
    for (const actor of [p.buyer, outsider]) await expect(instance.answerLateClaim({ ...answer(p, claimId), actor })).rejects.toMatchObject({ code: "not_available" });
    await expect(instance.answerLateClaim({ ...answer(p, claimId), receivedAmountVnd: 0 })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(instance.answerLateClaim({ ...answer(p, claimId, false), receivedAmountVnd: 1 })).rejects.toMatchObject({ code: "invalid_request" });
  });
  test("evidence attachment uses the buyer/claim binding and failure rolls the claim back", async () => {
    const p = await closedOrder(); const files = { attachResolutionEvidence: vi.fn(async () => "invalid" as "attached" | "invalid" | "disabled") };
    const instance = service(p, { files }); const command = { ...filing(p), fileIds: [randomUUID()] };
    await expect(instance.fileLateClaim(command)).rejects.toMatchObject({ code: "invalid_request" }); expect(await claims(p)).toHaveLength(0);
    files.attachResolutionEvidence.mockResolvedValue("attached"); const { claimId } = await instance.fileLateClaim(command);
    expect(files.attachResolutionEvidence).toHaveBeenLastCalledWith(expect.anything(), { orderId: p.orderId, ownerUserId: p.buyer.userId,
      target: { kind: "late_claim", id: claimId }, fileIds: command.fileIds, at: p.s.creator.now() });
    expect(await f.db.select().from(schema.systemOutbox).where(and(eq(schema.systemOutbox.aggregateId, claimId), eq(schema.systemOutbox.eventType, "resolution.late_claim_filed.v1")))).toHaveLength(1);
  });
  test("pause fairness accepts filing after day 30 within the effective deadline", async () => {
    const p = await closedOrder(); const close = (await order(p)).closedAt!; const rawDeadline = new Date(close.getTime() + resolution.RESOLUTION_POLICY.claimWindowMs);
    const pauseId = randomUUID(); const startedAt = new Date(rawDeadline.getTime() - 1); const endedAt = new Date(rawDeadline.getTime() + DAY);
    await f.db.insert(schema.commissionResolutionPauses).values({ id: pauseId, startedAt });
    try {
      p.s.creator.setNow(endedAt);
    } finally {
      await f.db.update(schema.commissionResolutionPauses).set({ endedAt, version: 2 }).where(eq(schema.commissionResolutionPauses.id, pauseId));
    }
    const effective = await f.db.transaction((tx) => resolution.effectiveResolutionDeadline(tx, rawDeadline));
    expect(effective).toEqual(new Date(endedAt.getTime() + resolution.RESOLUTION_POLICY.pauseGraceMs));
    expect(await service(p).fileLateClaim(filing(p))).toEqual({ claimId: expect.any(String) });
  });
  test("the claim guard accepts the extended boundary, rejects one millisecond later and refuses an open pause", async () => {
    const p = await closedOrder(); const close = (await order(p)).closedAt!;
    // Earlier tests have recorded pauses; use the current effective deadline for the next overlapping pause.
    const deadline = (await f.db.transaction((tx) => resolution.effectiveResolutionDeadline(tx, new Date(close.getTime() + resolution.RESOLUTION_POLICY.claimWindowMs))))!;
    const insert = (filedAt: Date) => {
      const id = randomUUID();
      return f.client`insert into commission_late_payment_claims (id, order_id, buyer_user_id, transfer_at, claimed_amount_vnd,
        reference_envelope, creator_respond_by, filed_at) values (${id}, ${p.orderId}, ${p.buyer.userId}, ${close.toISOString()}, 500000,
          ${JSON.stringify(kit(p).encrypt("commission_late_payment_claims", id, "bank_reference", "SYNTHETIC_REF"))}::jsonb,
          ${new Date(filedAt.getTime() + resolution.RESOLUTION_POLICY.claimResponseMs).toISOString()}, ${filedAt.toISOString()})`;
    };
    async function refused(at: Date) {
      try { await insert(at); } catch (error) { expect(error).toMatchObject({ code: "23514" }); return; }
      throw new Error("Expected SQLSTATE 23514");
    }
    const pauseId = randomUUID(); const endedAt = new Date(deadline.getTime() + DAY);
    await f.db.insert(schema.commissionResolutionPauses).values({ id: pauseId, startedAt: new Date(deadline.getTime() - 1) });
    try { await refused(deadline); }
    finally { await f.db.update(schema.commissionResolutionPauses).set({ endedAt, version: 2 }).where(eq(schema.commissionResolutionPauses.id, pauseId)); }
    const effective = (await f.db.transaction((tx) => resolution.effectiveResolutionDeadline(tx, deadline)))!;
    await refused(new Date(effective.getTime() + 1));
    await insert(effective); expect(await claims(p)).toHaveLength(1);
  });
});
