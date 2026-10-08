import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { importConfiguredBusinessCalendarVersion } from "@pawket/database";
import { createCommissionEvidenceAttachmentPort } from "@pawket/commission-files";
import { lockCommissionCreator } from "@pawket/orders";
import { createCommissionRefundPort, createCommissionRefundService, COMMISSION_REFUND_POLICY } from "@pawket/payments";
import { createTrustCasePort } from "@pawket/trust";
import { vietQrCrc16 } from "../../../packages/payments/src/vietqr.js";
import { commandIds, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";
import { createCommissionResolutionTestFixture } from "./commission-resolution-test-support.js";

const f = createCommissionResolutionTestFixture("i8refunds");
const calendarVersion = "vn-refund-party-test"; const currentCalendarVersion = "vn-refund-party-current";
const at = new Date("2026-10-09T04:00:00Z");
const accountNumber = "000000123456"; const correctedAccount = "000000654321";
beforeAll(async () => {
  await f.initialize();
  await f.db.transaction((tx) => importConfiguredBusinessCalendarVersion(tx, { version: calendarVersion, holidayDates: ["2026-10-12"] }));
  await f.db.transaction((tx) => importConfiguredBusinessCalendarVersion(tx, { version: currentCalendarVersion, holidayDates: ["2026-10-19"] }));
}, 60_000);
afterAll(f.dispose, 30_000);
type ServiceInput = Parameters<typeof createCommissionRefundService>[0];
async function setup() {
  const p = await f.paidOrder(); p.s.creator.setNow(at);
  const cases = createTrustCasePort();
  const created = await f.db.transaction((tx) => createCommissionRefundPort({ keyring: p.s.input.keyring, calendarVersion }).createObligation(tx, {
    orderId: p.orderId, paymentIntentId: p.confirmationCommand.paymentIntentId, creatorUserId: p.creator.userId, buyerUserId: p.buyer.userId,
    source: "agreement", sourceId: randomUUID(), amountVnd: 500_000, requestId: randomUUID(), at,
  }));
  const auth = { stale: false, enrolled: false, verified: true, revoked: false };
  const assurance: ServiceInput["assurance"] = { getTipSessionAssurance: vi.fn(async (_tx, actor, time) => {
    if (auth.revoked || p.s.users.get(actor.userId) !== actor.sessionId) return null;
    return { primaryAuthenticatedAt: new Date(time.getTime() - (auth.stale ? 3_600_001 : 0)), mfaEnrolled: auth.enrolled,
      mfaVerifiedAt: auth.verified ? time : null, sessionExpiresAt: new Date(time.getTime() + 60_000) };
  }) };
  const input: ServiceInput = { ...p.s.creator.common, applicationRevision: "synthetic-i8", calendarVersion, mode: "enabled",
    recentAuthMs: 3_600_000, mfaAuthMs: 300_000, assurance, cases, lockCreator: lockCommissionCreator,
    files: createCommissionEvidenceAttachmentPort({ keyring: p.s.input.keyring, mode: "enabled" }) };
  const service = createCommissionRefundService(input);
  return { p, obligationId: created.obligationId, auth, input, service, cases };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
const row = (c: Fixture) => f.db.select().from(schema.commissionRefundObligations).where(eq(schema.commissionRefundObligations.id, c.obligationId)).then((rows) => rows[0]!);
const events = (c: Fixture) => f.db.select().from(schema.commissionRefundEvents).where(eq(schema.commissionRefundEvents.obligationId, c.obligationId));
const sends = (c: Fixture) => f.db.select().from(schema.commissionRefundSends).where(eq(schema.commissionRefundSends.obligationId, c.obligationId));
const command = async (c: Fixture, actor = c.p.buyer) => ({ actor, obligationId: c.obligationId, expectedVersion: (await row(c)).version, ...commandIds() });
const destinationCommand = async (c: Fixture) => ({ ...await command(c), bankBin: "970422", accountNumber, accountHolder: "SYNTHETIC BUYER" });
const enter = async (c: Fixture, service = c.service) => service.enterDestination(await destinationCommand(c));
const revealCommand = (c: Fixture) => ({ actor: c.p.creator, obligationId: c.obligationId, requestId: randomUUID() });
const sendCommand = async (c: Fixture) => ({ ...await command(c, c.p.creator), transferDate: "2026-10-09", bankReference: " SYNTHETIC_1/a.b-c ", note: "Synthetic refund note" });
const send = async (c: Fixture, service = c.service) => service.recordSend(await sendCommand(c));

describe("commission refund party commands", () => {
  test("the buyer enters a refund account and the deadline is five business days later", async () => {
    const c = await setup(); expect(await enter(c)).toEqual({ version: 2 });
    const current = await row(c);
    expect(current).toMatchObject({ state: "awaiting_send", calendarVersion, destinationBankBin: "970422", destinationSuffix: "3456", destinationEnteredAt: at });
    expect(current.dueAt?.toISOString()).toBe("2026-10-19T16:59:59.999Z");
    expect(JSON.stringify(current).includes(accountNumber)).toBe(false);
    expect((await events(c)).map((event) => event.action)).toEqual(["created", "destination_entered"]);
  });
  test.each(["enterDestination", "revealDestination", "recordSend"] as const)("a stale session gets recent_auth_required for %s", async (method) => {
    const c = await setup(); if (method !== "enterDestination") await enter(c); c.auth.stale = true;
    const run = method === "enterDestination" ? c.service.enterDestination(await destinationCommand(c))
      : method === "revealDestination" ? c.service.revealDestination(revealCommand(c)) : send(c);
    await expect(run).rejects.toMatchObject({ code: "recent_auth_required" });
    expect((await row(c)).version).toBe(method === "enterDestination" ? 1 : 2);
  });
  test.each(["enterDestination", "revealDestination", "recordSend"] as const)("%s requires fresh enrolled MFA", async (method) => {
    const c = await setup(); if (method !== "enterDestination") await enter(c); c.auth.enrolled = true; c.auth.verified = false;
    const run = method === "enterDestination" ? c.service.enterDestination(await destinationCommand(c))
      : method === "revealDestination" ? c.service.revealDestination(revealCommand(c)) : send(c);
    await expect(run).rejects.toMatchObject({ code: "totp_required" });
  });
  test("the creator reveal returns a valid VietQR payload with the PKR reference and logs destination_revealed", async () => {
    const c = await setup(); await enter(c); const view = await c.service.revealDestination(revealCommand(c));
    expect(view.reference).toMatch(/^PKR[0-9A-HJKMNP-TV-Z]{12}$/u); expect(view.amountVnd).toBe(500_000);
    expect(view.accountNumber === accountNumber && view.accountHolder === "SYNTHETIC BUYER").toBe(true);
    expect(view.qrPayload.includes(view.reference) && view.qrPayload.includes(accountNumber)).toBe(true);
    expect(view.qrPayload.slice(-4)).toBe(vietQrCrc16(new TextEncoder().encode(view.qrPayload.slice(0, -4))));
    expect((await events(c)).filter((event) => event.action === "destination_revealed")).toMatchObject([{ actorUserId: c.p.creator.userId, actorSessionId: c.p.creator.sessionId }]);
    expect((await row(c)).version).toBe(2);
  });
  test("the buyer cannot reveal and an unrelated user gets not_available", async () => {
    const c = await setup(); await enter(c); const unrelated = await c.p.s.buyer();
    await expect(c.service.revealDestination({ ...revealCommand(c), actor: c.p.buyer })).rejects.toMatchObject({ code: "not_available" });
    await expect(c.service.revealDestination({ ...revealCommand(c), actor: unrelated })).rejects.toMatchObject({ code: "not_available" });
    await expect(c.service.enterDestination({ ...await destinationCommand(c), actor: c.p.creator })).rejects.toMatchObject({ code: "not_available" });
    await expect(c.service.recordSend({ ...await sendCommand(c), actor: c.p.buyer })).rejects.toMatchObject({ code: "not_available" });
    await expect(c.service.listForViewer({ actor: unrelated, orderId: c.p.orderId })).rejects.toMatchObject({ code: "not_available" });
  });
  test("correcting the account after a reveal restarts the deadline and the next reveal shows the new account", async () => {
    const c = await setup(); await enter(c); await c.service.revealDestination(revealCommand(c));
    c.p.s.creator.setNow(new Date("2026-10-16T04:00:00Z"));
    const currentService = createCommissionRefundService({ ...c.input, calendarVersion: currentCalendarVersion });
    expect(await currentService.enterDestination({ ...await destinationCommand(c), accountNumber: correctedAccount })).toEqual({ version: 3 });
    const current = await row(c); expect(current.calendarVersion).toBe(currentCalendarVersion);
    expect(current.dueAt?.toISOString()).toBe("2026-10-26T16:59:59.999Z");
    expect((await currentService.revealDestination(revealCommand(c))).accountNumber === correctedAccount).toBe(true);
    expect((await events(c)).filter((event) => event.action === "destination_revealed")).toHaveLength(2);
  });
  test("initial destination entry stores the service's current calendar version", async () => {
    const c = await setup(); c.p.s.creator.setNow(new Date("2026-10-16T04:00:00Z"));
    await enter(c, createCommissionRefundService({ ...c.input, calendarVersion: currentCalendarVersion }));
    expect((await row(c)).calendarVersion).toBe(currentCalendarVersion);
    expect((await row(c)).dueAt?.toISOString()).toBe("2026-10-26T16:59:59.999Z");
  });
  test("correction after a send is refused with invalid_transition, including after a required resend", async () => {
    const c = await setup(); await enter(c); await send(c);
    await expect(c.service.enterDestination({ ...await destinationCommand(c), accountNumber: correctedAccount })).rejects.toMatchObject({ code: "invalid_transition" });
    await c.service.confirmReceipt({ ...await command(c), received: false });
    await f.db.transaction((tx) => createCommissionRefundPort({ keyring: c.input.keyring, calendarVersion }).requireResend(tx, {
      obligationId: c.obligationId, actor: null, requestId: randomUUID(), at: c.p.s.creator.now(),
    }));
    await expect(c.service.enterDestination({ ...await destinationCommand(c), accountNumber: correctedAccount })).rejects.toMatchObject({ code: "invalid_transition" });
  });
  test.each(["2026-10-10", "2026-10-08", "2026-02-30"])("recordSend refuses invalid transfer date %s", async (transferDate) => {
    const c = await setup(); await enter(c);
    await expect(c.service.recordSend({ ...await sendCommand(c), transferDate })).rejects.toMatchObject({ code: "invalid_request" });
    expect(await sends(c)).toHaveLength(0); expect((await row(c)).state).toBe("awaiting_send");
  });
  test("recordSend checks creation and today using Vietnam dates", async () => {
    const c = await setup(); await enter(c); c.p.s.creator.setNow(new Date("2026-10-09T17:30:00Z"));
    await c.service.recordSend({ ...await sendCommand(c), transferDate: "2026-10-10" });
    expect((await row(c)).state).toBe("sent");
  });
  test("recordSend resolves an open refund_overdue case and commits the send and sent state together", async () => {
    const c = await setup(); await enter(c);
    const overdue = await f.db.transaction((tx) => c.cases.openCase(tx, { kind: "refund_overdue", orderId: c.p.orderId,
      sourceType: "commission_refund_obligation", sourceId: c.obligationId, policyRevisionId: null, requestId: randomUUID(), at }));
    await send(c); const current = await row(c); const records = await sends(c);
    expect(records).toHaveLength(1); expect(current).toMatchObject({ state: "sent", currentSendId: records[0]!.id, version: 3 });
    expect(current.confirmBy?.getTime()).toBe(at.getTime() + COMMISSION_REFUND_POLICY.confirmWindowMs);
    const [resolved] = await f.db.select().from(schema.trustCases).where(eq(schema.trustCases.id, overdue.caseId));
    expect(resolved).toMatchObject({ state: "resolved", resolutionKind: "send_recorded" });
    expect(JSON.stringify(records).includes("SYNTHETIC_1") || JSON.stringify(records).includes("Synthetic refund note")).toBe(false);
  });
  test.each([true, false])("the buyer confirms receipt received=%s with the matching state and case", async (received) => {
    const c = await setup(); await enter(c); await send(c); await c.service.confirmReceipt({ ...await command(c), received });
    expect((await row(c)).state).toBe(received ? "received" : "not_received");
    expect((await row(c)).endedAt).toEqual(received ? at : null);
    expect(await f.db.transaction((tx) => c.cases.findOpenCase(tx, { kind: "refund_not_received", sourceId: c.obligationId })) === null).toBe(received);
    expect((await events(c)).at(-1)?.action).toBe(received ? "receipt_confirmed" : "receipt_denied");
  });
  test("receipt requires the buyer, sent state and the unexpired confirmation window", async () => {
    const c = await setup(); await enter(c);
    await expect(c.service.confirmReceipt({ ...await command(c), received: true })).rejects.toMatchObject({ code: "invalid_transition" });
    await send(c);
    await expect(c.service.confirmReceipt({ ...await command(c, c.p.creator), received: true })).rejects.toMatchObject({ code: "not_available" });
    c.p.s.creator.setNow(new Date(at.getTime() + COMMISSION_REFUND_POLICY.confirmWindowMs));
    await expect(c.service.confirmReceipt({ ...await command(c), received: true })).rejects.toMatchObject({ code: "invalid_transition" });
  });
  test("listForViewer never contains the account number and includes stored deadlines and send text", async () => {
    const c = await setup(); await enter(c); await send(c);
    for (const actor of [c.p.buyer, c.p.creator]) {
      const view = await c.service.listForViewer({ actor, orderId: c.p.orderId });
      const serialized = JSON.stringify(view);
      expect(serialized.includes(accountNumber) || serialized.includes("Envelope")).toBe(false);
      expect(view[0]).toMatchObject({ obligationId: c.obligationId, amountVnd: 500_000, state: "sent", suffix: "3456",
        dueAt: "2026-10-19T16:59:59.999Z", confirmBy: new Date(at.getTime() + COMMISSION_REFUND_POLICY.confirmWindowMs).toISOString() });
      expect(view[0]!.sends[0]!.bankReference === "SYNTHETIC_1/a.b-c" && view[0]!.sends[0]!.note === "Synthetic refund note").toBe(true);
    }
  });
  test("mode disabled refuses every command with resolution_disabled and still allows party reads", async () => {
    const c = await setup(); await enter(c); const disabled = createCommissionRefundService({ ...c.input, mode: "disabled" });
    await expect(enter(c, disabled)).rejects.toMatchObject({ code: "resolution_disabled" });
    await expect(disabled.revealDestination(revealCommand(c))).rejects.toMatchObject({ code: "resolution_disabled" });
    await expect(send(c, disabled)).rejects.toMatchObject({ code: "resolution_disabled" });
    await expect(disabled.confirmReceipt({ ...await command(c), received: true })).rejects.toMatchObject({ code: "resolution_disabled" });
    expect(await disabled.listForViewer({ actor: c.p.buyer, orderId: c.p.orderId })).toHaveLength(1);
  });
  test("every command calls lockCreator with the obligation's creator before writing refund data", async () => {
    const c = await setup(); let expectedVersion = 1; let expectedEvents = 1; let expectedSends = 0;
    const lockCreator: ServiceInput["lockCreator"] = vi.fn(async (tx, creatorUserId) => {
      expect(creatorUserId).toBe(c.p.creator.userId); await lockCommissionCreator(tx, creatorUserId);
      const [current] = await tx.select().from(schema.commissionRefundObligations).where(eq(schema.commissionRefundObligations.id, c.obligationId));
      expect(current!.version).toBe(expectedVersion);
      expect(await tx.select({ id: schema.commissionRefundEvents.id }).from(schema.commissionRefundEvents).where(eq(schema.commissionRefundEvents.obligationId, c.obligationId))).toHaveLength(expectedEvents);
      expect(await tx.select({ id: schema.commissionRefundSends.id }).from(schema.commissionRefundSends).where(eq(schema.commissionRefundSends.obligationId, c.obligationId))).toHaveLength(expectedSends);
    });
    const service = createCommissionRefundService({ ...c.input, lockCreator });
    await enter(c, service); expectedVersion = 2; expectedEvents = 2;
    await service.revealDestination(revealCommand(c)); expectedEvents = 3;
    await send(c, service); expectedVersion = 3; expectedEvents = 4; expectedSends = 1;
    await service.confirmReceipt({ ...await command(c), received: true }); expect(lockCreator).toHaveBeenCalledTimes(4);
  });
  test("commands replay the recorded version after later changes and reject a conflicting payload", async () => {
    const c = await setup(); const destination = await destinationCommand(c); const result = await c.service.enterDestination(destination);
    await c.service.enterDestination({ ...await destinationCommand(c), accountNumber: correctedAccount });
    expect(await c.service.enterDestination(destination)).toEqual(result);
    await expect(c.service.enterDestination({ ...destination, accountNumber: correctedAccount })).rejects.toMatchObject({ code: "idempotency_conflict" });
    const sending = await sendCommand(c); const sendResult = await c.service.recordSend(sending);
    const receipt = { ...await command(c), received: true }; const receiptResult = await c.service.confirmReceipt(receipt);
    const before = await row(c); const count = (await events(c)).length;
    expect(await c.service.recordSend(sending)).toEqual(sendResult); expect(await c.service.confirmReceipt(receipt)).toEqual(receiptResult);
    expect((await row(c)).version).toBe(before.version); expect(await events(c)).toHaveLength(count); expect(await sends(c)).toHaveLength(1);
  });
  test("fileIds is refused while the optional files port is absent, including an empty array", async () => {
    const c = await setup(); await enter(c);
    const service = createCommissionRefundService({ ...c.input, files: undefined });
    for (const fileIds of [[], [randomUUID()]]) await expect(service.recordSend({ ...await sendCommand(c), fileIds })).rejects.toMatchObject({ code: "invalid_request" });
    expect(await sends(c)).toHaveLength(0);
  });
  test("evidence is attached to the inserted send in the same transaction and an invalid attachment rolls back", async () => {
    const c = await setup(); await enter(c); const fileIds = [randomUUID()];
    const attach = vi.fn<NonNullable<ServiceInput["files"]>["attachResolutionEvidence"]>(async (tx, attachment) => {
      expect(attachment).toMatchObject({ orderId: c.p.orderId, ownerUserId: c.p.creator.userId, target: { kind: "refund_send" }, fileIds });
      const [inserted] = await tx.select({ id: schema.commissionRefundSends.id }).from(schema.commissionRefundSends).where(eq(schema.commissionRefundSends.id, attachment.target.id));
      expect(inserted?.id).toBe(attachment.target.id); return "invalid";
    });
    const service = createCommissionRefundService({ ...c.input, files: { attachResolutionEvidence: attach } });
    await expect(service.recordSend({ ...await sendCommand(c), fileIds })).rejects.toMatchObject({ code: "invalid_request" });
    expect(await sends(c)).toHaveLength(0); expect((await row(c)).version).toBe(2);
  });
  test("a case failure rolls back the send, obligation, event and idempotency record", async () => {
    const c = await setup(); await enter(c); const sending = await sendCommand(c);
    const broken = createCommissionRefundService({ ...c.input, cases: { ...c.cases, findOpenCase: async () => { throw new Error("Synthetic dependency failure"); } } });
    await expect(broken.recordSend(sending)).rejects.toMatchObject({ code: "dependency_unavailable" });
    expect(await sends(c)).toHaveLength(0); expect((await row(c)).version).toBe(2); expect(await events(c)).toHaveLength(2);
    await c.service.recordSend(sending); expect((await row(c)).state).toBe("sent");
  });
  test("denial without a cases port refuses atomically", async () => {
    const c = await setup(); await enter(c); await send(c);
    await expect(createCommissionRefundService({ ...c.input, cases: undefined }).confirmReceipt({ ...await command(c), received: false }))
      .rejects.toMatchObject({ code: "dependency_unavailable" });
    expect((await row(c)).state).toBe("sent");
  });
  test("commit-time session revocation rolls back writes and also blocks reads and replays", async () => {
    const c = await setup(); const destination = await destinationCommand(c);
    const normal = c.input.assurance.getTipSessionAssurance; let calls = 0;
    const service = createCommissionRefundService({ ...c.input, assurance: { getTipSessionAssurance: async (...args) => ++calls === 1 ? normal(...args) : null } });
    await expect(service.enterDestination(destination)).rejects.toMatchObject({ code: "not_available" });
    expect((await row(c)).version).toBe(1); expect(await events(c)).toHaveLength(1);
    await c.service.enterDestination(destination); c.auth.revoked = true;
    await expect(c.service.enterDestination(destination)).rejects.toMatchObject({ code: "not_available" });
    await expect(c.service.listForViewer({ actor: c.p.buyer, orderId: c.p.orderId })).rejects.toMatchObject({ code: "not_available" });
  });
  test("stale versions and racing sends write exactly one send", async () => {
    const c = await setup(); const stale = await destinationCommand(c); await enter(c);
    await expect(c.service.enterDestination(stale)).rejects.toMatchObject({ code: "version_conflict" });
    const sending = await sendCommand(c); const results = await Promise.allSettled([c.service.recordSend(sending), c.service.recordSend({ ...sending, ...commandIds() })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([{ reason: { code: "version_conflict" } }]);
    expect(await sends(c)).toHaveLength(1); expect((await row(c)).version).toBe(3);
  });
  test.each(["999999", "970436"])("invalid refund destinations fail safely for bank %s", async (bankBin) => {
    const c = await setup();
    await expect(c.service.enterDestination({ ...await destinationCommand(c), bankBin, accountNumber: bankBin === "970436" ? "1".repeat(20) : accountNumber }))
      .rejects.toMatchObject({ code: "invalid_destination" });
    expect((await row(c)).version).toBe(1);
  });
  test("refund events and outbox contain no account number or send text", async () => {
    const c = await setup(); await enter(c); await c.service.revealDestination(revealCommand(c)); await send(c);
    await c.service.confirmReceipt({ ...await command(c), received: false });
    const outbox = await f.db.select().from(schema.systemOutbox).where(and(eq(schema.systemOutbox.aggregateType, "trust_case")));
    const serialized = JSON.stringify([await events(c), outbox.map((event) => event.payload)]);
    expect([accountNumber, "SYNTHETIC_1", "Synthetic refund note"].some((value) => serialized.includes(value))).toBe(false);
  });
});
