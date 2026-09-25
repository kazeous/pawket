import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createSePayReviewService } from "../src/sepay-review-service.js";
import { commandIds, createSePayIntegrationFixture, schema } from "./sepay-integration-fixture.js";

const fixture = createSePayIntegrationFixture("review");
beforeAll(fixture.initialize, 30_000); afterAll(fixture.dispose, 30_000);
type Creator = Awaited<ReturnType<typeof fixture.creator>>;
function reviews(creator: Creator, options: { disabled?: boolean; owner?: boolean } = {}) {
  return createSePayReviewService({ ...creator.common, assurance: creator.assurance, paymentsMode: options.disabled ? "disabled" : "sepay_optional",
    applicationRevision: "synthetic-review", authorizeOwner: vi.fn(async () => options.owner ?? false) });
}
async function exception(creator: Creator) {
  const connected = await creator.connect(); const intent = await creator.createIntent();
  await creator.inbox.receive(creator.signed(connected.connection.id, connected.secret, creator.event(intent.reference)));
  const [inbox] = await fixture.db.select().from(schema.paymentsSepayInbox).where(eq(schema.paymentsSepayInbox.connectionId, connected.connection.id));
  expect(await creator.reconciliation.processInbox(inbox!.id)).toBe("review_required");
  const [state] = await fixture.db.select().from(schema.paymentsSepayProcessing).where(eq(schema.paymentsSepayProcessing.inboxId, inbox!.id));
  return { connected, intent, inbox: inbox!, state: state! };
}

describe("private SePay exception review and owner diagnostics", () => {
  test("creator reads only owned masked evidence and cannot use another creator's cursor", async () => {
    const creator = await fixture.creator(); const own = await exception(creator);
    const other = await fixture.creator(); const foreign = await exception(other);
    const service = reviews(creator); const result = await service.list({ actor: creator.actor });
    expect(result.items).toEqual([{ id: own.inbox.id, connectionId: own.connected.connection.id, version: own.state.version, status: "review_required",
      reason: "automation_paused", amountVnd: 50_000, reference: own.intent.reference, receivedAt: own.inbox.receivedAt.toISOString() }]);
    expect(JSON.stringify(result)).not.toMatch(/accountNumber|secret|envelope|guest|synthetic-access/iu);
    await expect(service.list({ actor: creator.actor, cursor: foreign.inbox.id })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.list({ actor: { ...creator.actor, sessionId: "revoked-session" } })).rejects.toMatchObject({ code: "not_authorized" });
  });

  test("dismiss/reopen/retry append one decision per idempotent command and never change payment state", async () => {
    const creator = await fixture.creator(); const item = await exception(creator); const service = reviews(creator);
    const command = { actor: creator.actor, inboxId: item.inbox.id, expectedVersion: item.state.version, action: "dismiss" as const, reason: "Checked synthetic bank history", ...commandIds() };
    await service.decide(command); await service.decide(command);
    await expect(service.decide({ ...command, reason: "Different explanation" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    let queue = await service.list({ actor: creator.actor, status: "dismissed" });
    expect(queue.items).toHaveLength(1);
    await service.decide({ ...command, ...commandIds(), expectedVersion: queue.items[0]!.version, action: "reopen" });
    queue = await service.list({ actor: creator.actor });
    await service.decide({ ...command, ...commandIds(), expectedVersion: queue.items[0]!.version, action: "retry" });
    expect((await service.list({ actor: creator.actor, status: "pending" })).items).toHaveLength(1);
    const decisions = await fixture.db.select().from(schema.paymentsSepayDecisions).where(eq(schema.paymentsSepayDecisions.inboxId, item.inbox.id));
    expect(decisions.filter((row) => row.action !== "review_required").map((row) => row.action).sort()).toEqual(["dismiss", "reopen", "retry"]);
    expect(decisions.filter((row) => row.actorUserId === creator.actor.userId)).toHaveLength(3);
    expect((await fixture.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, item.intent.id)))[0]?.state).toBe("awaiting_transfer");
    expect(await fixture.db.select().from(schema.paymentConfirmations).where(eq(schema.paymentConfirmations.paymentIntentId, item.intent.id))).toHaveLength(0);
    expect(creator.provider.readback).not.toHaveBeenCalled();
  });

  test("foreign actors, stale versions and disabled mode cannot decide exceptions", async () => {
    const creator = await fixture.creator(); const item = await exception(creator); const other = await fixture.creator();
    const command = { actor: creator.actor, inboxId: item.inbox.id, expectedVersion: item.state.version, action: "dismiss" as const, reason: "Checked synthetic bank history", ...commandIds() };
    await expect(reviews(other).decide({ ...command, actor: other.actor })).rejects.toMatchObject({ code: "not_available" });
    await expect(reviews(creator).decide({ ...command, expectedVersion: item.state.version - 1 })).rejects.toMatchObject({ code: "version_conflict" });
    await expect(reviews(creator, { disabled: true }).decide(command)).rejects.toMatchObject({ code: "payments_disabled" });
    expect((await reviews(creator, { disabled: true }).list({ actor: creator.actor })).items).toHaveLength(1);
    expect((await fixture.db.select().from(schema.paymentsSepayProcessing).where(eq(schema.paymentsSepayProcessing.inboxId, item.inbox.id)))[0]).toEqual(item.state);
  });

  test("owner diagnostics require their own permission and expose only operational masked fields", async () => {
    const creator = await fixture.creator(); const item = await exception(creator);
    await expect(reviews(creator).diagnostics(creator.actor)).rejects.toMatchObject({ code: "not_authorized" });
    const diagnostics = await reviews(creator, { owner: true }).diagnostics({ userId: "synthetic-owner", sessionId: "synthetic-owner-session" });
    const row = diagnostics.items.find((entry) => entry.connectionId === item.connected.connection.id);
    expect(row).toEqual({ connectionId: item.connected.connection.id, status: "ready", version: item.connected.connection.version,
      bankName: "Vietcombank", maskedSuffix: `•••• ${creator.accountNumber.slice(-4)}`, pendingCount: 0, reviewCount: 1,
      lastReceivedAt: item.inbox.receivedAt.toISOString(), remoteRevocationStatus: "not_requested" });
    expect(JSON.stringify(diagnostics)).not.toMatch(/accountNumber|reference|guest|secret|Envelope|accessToken|refreshToken/iu);
    expect(JSON.stringify(diagnostics)).not.toContain(creator.accountNumber);
  });
});
