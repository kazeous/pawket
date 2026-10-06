import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createCommissionThreadPort, createCommissionThreadService, encryptCommissionFileName } from "@pawket/commission-files";
import { createCommissionFileAccessPort, createCommissionOrderService } from "@pawket/orders";
import { createCreatorCommissionPaymentService } from "@pawket/payments";
import { decryptSensitiveField } from "@pawket/security";
import { createCommissionOrderTestFixture } from "./commission-order-test-support.js";
import { commandIds, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";

const fixture = createCommissionOrderTestFixture("i7fulfillment");
beforeAll(fixture.initialize, 60_000); afterAll(fixture.dispose);
const HOUR = 3_600_000; const DAY = 24 * HOUR;
type Paid = Awaited<ReturnType<typeof fixture.paidOrder>>;
type Options = Partial<Parameters<typeof createCommissionOrderService>[0]>;
function service(p: Paid, options: Options = {}) {
  return createCommissionOrderService({ ...p.s.input, fulfillmentMode: "enabled",
    thread: createCommissionThreadPort({ keyring: p.s.input.keyring, mode: "enabled" }), ...options });
}
const order = (p: Paid) => fixture.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, p.orderId)).then((rows) => rows[0]!);
const submissions = (p: Paid) => fixture.db.select().from(schema.commissionSubmissions).where(eq(schema.commissionSubmissions.orderId, p.orderId));
const events = (p: Paid) => fixture.db.select().from(schema.commissionEvents).where(eq(schema.commissionEvents.orderId, p.orderId)).orderBy(asc(schema.commissionEvents.orderVersion));
async function cleanFile(p: Paid, options: { context?: "thread" | "submission"; ownerUserId?: string; state?: "scanning" | "clean" } = {}) {
  const id = randomUUID(); const at = p.s.creator.now();
  await fixture.db.insert(schema.commissionFiles).values({ id, ownerUserId: options.ownerUserId ?? p.creator.userId,
    context: options.context ?? "submission", uploadOrderId: p.orderId, declaredBytes: 16,
    filenameEnvelope: encryptCommissionFileName(p.s.input.keyring, id, "Synthetic artwork"), objectKey: `commission/${id}`,
    uploadExpiresAt: new Date(at.getTime() + 900_000), requestId: "fixture", createdAt: at, updatedAt: at });
  await fixture.db.update(schema.commissionFiles).set({ state: "scanning", uploadedAt: at, scanDeadlineAt: new Date(at.getTime() + DAY), version: 2, updatedAt: at }).where(eq(schema.commissionFiles.id, id));
  if (options.state !== "scanning") await fixture.db.update(schema.commissionFiles).set({ state: "clean", sha256: `sha256:${"d".repeat(64)}`,
    detectedType: "png", quarantineVersionId: "q", cleanVersionId: "c", cleanAt: at, version: 3, updatedAt: at }).where(eq(schema.commissionFiles.id, id));
  return id;
}
async function submitCommand(p: Paid, kind: "draft" | "final" = "draft") {
  return { actor: p.creator, orderId: p.orderId, expectedVersion: (await order(p)).version,
    kind, note: "Synthetic note <3", fileIds: [await cleanFile(p)], ...commandIds() };
}
async function submit(p: Paid, kind: "draft" | "final" = "draft", instance = service(p)) {
  const command = await submitCommand(p, kind);
  expect(await instance.submit(command)).toBe(p.orderId);
  return (await submissions(p)).find((row) => row.requestId === command.requestId)!;
}
async function responseCommand(p: Paid, submissionId: string, response: "approve" | "request_changes" | "accept" = "accept") {
  return { actor: p.buyer, orderId: p.orderId, expectedVersion: (await order(p)).version, submissionId, response,
    note: response === "request_changes" ? "Synthetic change request" : undefined, ...commandIds() };
}
async function respond(p: Paid, submissionId: string, response: "approve" | "request_changes" | "accept", instance = service(p)) {
  return instance.respondToSubmission(await responseCommand(p, submissionId, response));
}
async function pause(startedAt: Date, endedAt: Date | null) {
  const id = randomUUID(); await fixture.db.insert(schema.commissionFulfillmentPauses).values({ id, startedAt });
  if (endedAt) await fixture.db.update(schema.commissionFulfillmentPauses).set({ endedAt }).where(eq(schema.commissionFulfillmentPauses.id, id));
  return id;
}

describe("commission submissions and buyer acceptance", () => {
  test("spec example: two rounds, seven days, buyer acceptance frees the slot", async () => {
    const p = await fixture.paidOrder({ revisionAllowance: 2, reviewWindowDays: 7 }); const instance = service(p);
    const first = await submit(p, "draft", instance);
    await respond(p, first.id, "request_changes", instance);
    expect((await order(p)).revisionsUsed).toBe(1);
    const second = await submit(p, "draft", instance);
    const version = (await order(p)).version;
    await respond(p, second.id, "approve", instance);
    expect(await order(p)).toMatchObject({ revisionsUsed: 1, version, state: "in_progress" });
    p.s.creator.setNow(new Date("2026-11-10T07:00Z")); const final = await submit(p, "final", instance);
    expect((await instance.getOrder({ actor: p.buyer, orderId: p.orderId })).fulfillment).toMatchObject({
      reviewEndsAt: "2026-11-17T07:00:00.000Z", completionDueAt: "2026-11-17T07:00:00.000Z", revisionsUsed: 1, revisionAllowance: 2, lateDelivery: true });
    p.s.creator.advance(HOUR); await respond(p, final.id, "accept", instance);
    const completed = await instance.getOrder({ actor: p.buyer, orderId: p.orderId });
    expect(completed).toMatchObject({ state: "completed", fulfillment: { completionKind: "buyer_accepted",
      completedAt: "2026-11-10T08:00:00.000Z", fileDeletionAt: new Date(p.s.creator.now().getTime() + 180 * DAY).toISOString() } });
    const [slot] = await fixture.db.select().from(schema.commissionReservations).where(eq(schema.commissionReservations.orderId, p.orderId));
    expect(slot).toMatchObject({ state: "completed", releasedAt: p.s.creator.now() });
    const history = await events(p);
    expect(history.map((row) => [row.orderVersion, row.type, row.reason])).toEqual([
      [1, "awaiting_payment", null], [2, "in_progress", null], [3, "in_progress", "draft_changes_requested"],
      [4, "delivered", null], [5, "completed", "buyer_accepted"]]);
    const outbox = await fixture.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.aggregateId, p.orderId));
    expect(outbox.filter((row) => row.eventType === "commission.submission_sent.v1")).toHaveLength(3);
    expect(outbox.filter((row) => row.eventType === "commission.submission_responded.v1").map((row) => row.payload.response).sort()).toEqual(["approved", "changes_requested"]);
    expect(outbox.every((row) => !/note|filename|objectKey|url/iu.test(Object.keys(row.payload).join(" ")))).toBe(true);
    const persisted = (await submissions(p)).find((row) => row.id === first.id)!;
    expect(persisted.noteEnvelope).not.toBeNull(); expect(persisted.responseNoteEnvelope).not.toBeNull();
    expect(decryptSensitiveField({ keyring: p.s.input.keyring, envelope: persisted.noteEnvelope!,
      binding: { recordType: "commission_submissions", recordId: first.id, fieldName: "note" } }) === "Synthetic note <3").toBe(true);
    expect(decryptSensitiveField({ keyring: p.s.input.keyring, envelope: persisted.responseNoteEnvelope!,
      binding: { recordType: "commission_submissions", recordId: first.id, fieldName: "response_note" } }) === "Synthetic change request").toBe(true);
  });
  test("responding to a superseded draft is refused; a final also supersedes an open draft", async () => {
    const p = await fixture.paidOrder(); const first = await submit(p); const second = await submit(p);
    await expect(respond(p, first.id, "approve")).rejects.toMatchObject({ code: "invalid_transition" });
    await submit(p, "final");
    expect((await submissions(p)).filter((row) => [first.id, second.id].includes(row.id)).map((row) => row.response)).toEqual(["superseded", "superseded"]);
    await expect(respond(p, second.id, "request_changes")).rejects.toMatchObject({ code: "invalid_transition" });
  });
  test.each(["draft", "final"] as const)("request changes on %s with no rounds left is refused", async (kind) => {
    const p = await fixture.paidOrder({ revisionAllowance: 0 }); const item = await submit(p, kind);
    await expect(respond(p, item.id, "request_changes")).rejects.toMatchObject({ code: "revisions_exhausted" });
    expect((await order(p)).revisionsUsed).toBe(0);
  });
  test.each(["draft", "final"] as const)("cannot submit a %s while delivered", async (kind) => {
    const p = await fixture.paidOrder(); await submit(p, "final");
    await expect(service(p).submit(await submitCommand(p, kind))).rejects.toMatchObject({ code: "invalid_transition" });
  });
  test.each(["accept", "request_changes"] as const)("%s at exactly reviewEndsAt is expired", async (response) => {
    const p = await fixture.paidOrder(); const final = await submit(p, "final"); p.s.creator.setNow((await order(p)).reviewEndsAt!);
    await expect(respond(p, final.id, response)).rejects.toMatchObject({ code: "expired" });
    expect((await order(p)).state).toBe("delivered");
  });
  test("buyer cannot submit and creator cannot respond", async () => {
    const p = await fixture.paidOrder(); const command = await submitCommand(p);
    await expect(service(p).submit({ ...command, actor: p.buyer })).rejects.toMatchObject({ code: "not_authorized" });
    const draft = await submit(p);
    await expect(service(p).respondToSubmission({ ...await responseCommand(p, draft.id, "approve"), actor: p.creator })).rejects.toMatchObject({ code: "not_authorized" });
  });
  test("all submission and response commands on completed orders are refused", async () => {
    const p = await fixture.paidOrder(); const final = await submit(p, "final"); await respond(p, final.id, "accept");
    for (const kind of ["draft", "final"] as const) await expect(service(p).submit(await submitCommand(p, kind))).rejects.toMatchObject({ code: "invalid_transition" });
    for (const response of ["approve", "request_changes", "accept"] as const) await expect(respond(p, final.id, response)).rejects.toMatchObject({ code: "invalid_transition" });
    const thread = await service(p).getThread({ actor: p.buyer, orderId: p.orderId });
    expect(thread.writable).toBe(false); expect(thread.items.every((item) => item.kind !== "submission" || !item.actionable)).toBe(true);
  });
  test("disabled fulfillment blocks every command but preserves thread reads", async () => {
    const p = await fixture.paidOrder(); const final = await submit(p, "final"); const disabled = service(p, { fulfillmentMode: "disabled" });
    for (const kind of ["draft", "final"] as const) await expect(disabled.submit(await submitCommand(p, kind))).rejects.toMatchObject({ code: "fulfillment_disabled" });
    for (const response of ["approve", "request_changes", "accept"] as const) await expect(respond(p, final.id, response, disabled)).rejects.toMatchObject({ code: "fulfillment_disabled" });
    const thread = await disabled.getThread({ actor: p.buyer, orderId: p.orderId });
    expect(thread.writable).toBe(false); expect(thread.items).toHaveLength(1);
    expect(thread.items.every((item) => item.kind !== "submission" || !item.actionable)).toBe(true);
  });
  test("without a thread port every fulfillment command and thread read fails closed", async () => {
    const p = await fixture.paidOrder(); const final = await submit(p, "final"); const unwired = service(p, { thread: undefined });
    for (const kind of ["draft", "final"] as const) await expect(unwired.submit(await submitCommand(p, kind))).rejects.toMatchObject({ code: "fulfillment_disabled" });
    for (const response of ["approve", "request_changes", "accept"] as const) await expect(respond(p, final.id, response, unwired)).rejects.toMatchObject({ code: "fulfillment_disabled" });
    await expect(unwired.getThread({ actor: p.buyer, orderId: p.orderId })).rejects.toMatchObject({ code: "fulfillment_disabled" });
  });
  test("stale expectedVersion is refused for both submission and response", async () => {
    const p = await fixture.paidOrder(); const command = await submitCommand(p);
    await expect(service(p).submit({ ...command, expectedVersion: command.expectedVersion - 1 })).rejects.toMatchObject({ code: "version_conflict" });
    const final = await submit(p, "final"); const accept = await responseCommand(p, final.id);
    await expect(service(p).respondToSubmission({ ...accept, expectedVersion: accept.expectedVersion - 1 })).rejects.toMatchObject({ code: "version_conflict" });
  });
  test("request changes on a final reopens the order with the original dueAt", async () => {
    const p = await fixture.paidOrder(); const dueAt = (await order(p)).dueAt!;
    p.s.creator.setNow(new Date(dueAt.getTime() - HOUR)); const final = await submit(p, "final");
    await respond(p, final.id, "request_changes");
    expect(await order(p)).toMatchObject({ state: "in_progress", deliveredAt: null, reviewEndsAt: null, revisionsUsed: 1, dueAt });
    p.s.creator.setNow(new Date(dueAt.getTime() + HOUR)); await submit(p, "final");
    const thread = await service(p).getThread({ actor: p.buyer, orderId: p.orderId });
    expect(thread.items.map((item) => item.kind === "submission" && item.late)).toEqual([true, false]);
    expect((await events(p)).find((row) => row.reason === "final_changes_requested")?.type).toBe("in_progress");
  });
  test("concurrent accept and request changes: exactly one commits", async () => {
    const p = await fixture.paidOrder(); const final = await submit(p, "final"); const version = (await order(p)).version;
    const results = await Promise.allSettled([respond(p, final.id, "accept"), respond(p, final.id, "request_changes")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(["version_conflict", "invalid_transition"]).toContain(rejected.reason.code);
    const current = await order(p); expect(current.version).toBe(version + 1);
    const [slot] = await fixture.db.select().from(schema.commissionReservations).where(eq(schema.commissionReservations.orderId, p.orderId));
    expect(slot!.state).toBe(current.state === "completed" ? "completed" : "occupied");
    expect(slot!.releasedAt !== null).toBe(current.state === "completed");
    const history = await events(p); expect(history.map((row) => row.orderVersion)).toEqual(Array.from({ length: current.version }, (_, index) => index + 1));
  });
  test("replay of submit and accept returns the recorded order id; changed payload conflicts", async () => {
    const p = await fixture.paidOrder(); const instance = service(p); const command = await submitCommand(p, "final");
    expect(await instance.submit(command)).toBe(p.orderId); expect(await instance.submit(command)).toBe(p.orderId);
    await expect(instance.submit({ ...command, kind: "draft" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    const final = (await submissions(p))[0]!; const accept = await responseCommand(p, final.id);
    expect(await instance.respondToSubmission(accept)).toBe(p.orderId); expect(await instance.respondToSubmission(accept)).toBe(p.orderId);
    await expect(instance.respondToSubmission({ ...accept, response: "request_changes", note: "Synthetic request" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await submissions(p)).toHaveLength(1); expect((await events(p)).filter((row) => row.type === "completed")).toHaveLength(1);
  });
  test("a fake completion hold blocks acceptance inside the completing transaction", async () => {
    const p = await fixture.paidOrder(); const final = await submit(p, "final");
    const hold = vi.fn(async () => true);
    await expect(respond(p, final.id, "accept", service(p, { holds: { hasActiveCompletionHold: hold } }))).rejects.toMatchObject({ code: "completion_held" });
    expect(hold).toHaveBeenCalledTimes(1); expect((await order(p)).state).toBe("delivered");
  });
  test.each([47, 48])("pause grace permits acceptance at resume + %ih only before the boundary", async (hours) => {
    const p = await fixture.paidOrder(); const final = await submit(p, "final"); const review = (await order(p)).reviewEndsAt!;
    const resumed = new Date(review.getTime() + DAY); await pause(new Date(review.getTime() - HOUR), resumed);
    p.s.creator.setNow(new Date(resumed.getTime() + hours * HOUR));
    expect((await service(p).getOrder({ actor: p.buyer, orderId: p.orderId })).fulfillment?.completionDueAt).toBe(new Date(resumed.getTime() + 48 * HOUR).toISOString());
    if (hours === 47) await expect(respond(p, final.id, "accept")).resolves.toBe(p.orderId);
    else await expect(respond(p, final.id, "accept")).rejects.toMatchObject({ code: "expired" });
  });
  test("an open pause removes the completion deadline and buyer actions", async () => {
    const p = await fixture.paidOrder(); p.s.creator.setNow(new Date("2027-01-01T00:00Z")); const final = await submit(p, "final");
    const review = (await order(p)).reviewEndsAt!; const pauseId = await pause(new Date(review.getTime() - HOUR), null);
    try {
      expect((await service(p).getOrder({ actor: p.buyer, orderId: p.orderId })).fulfillment?.completionDueAt).toBeNull();
      await expect(respond(p, final.id, "accept")).rejects.toMatchObject({ code: "fulfillment_disabled" });
      await expect(respond(p, final.id, "request_changes")).rejects.toMatchObject({ code: "fulfillment_disabled" });
      const thread = await service(p).getThread({ actor: p.buyer, orderId: p.orderId });
      expect(thread.items.every((item) => item.kind !== "submission" || !item.actionable)).toBe(true);
    } finally { await fixture.db.update(schema.commissionFulfillmentPauses).set({ endedAt: new Date(review.getTime() + DAY) }).where(eq(schema.commissionFulfillmentPauses.id, pauseId)); }
  });
  test("deadline and session are rechecked after writes before commit", async () => {
    const p = await fixture.paidOrder(); const final = await submit(p, "final");
    const due = new Date((await service(p).getOrder({ actor: p.buyer, orderId: p.orderId })).fulfillment!.completionDueAt!);
    p.s.creator.setNow(new Date(due.getTime() - 1));
    const holds = { hasActiveCompletionHold: async () => { p.s.creator.setNow(due); return false; } };
    await expect(respond(p, final.id, "accept", service(p, { holds }))).rejects.toMatchObject({ code: "expired" });
    expect((await order(p)).state).toBe("delivered");
    p.s.creator.setNow(new Date(due.getTime() - HOUR));
    const delayed = { hasActiveCompletionHold: async () => { p.s.creator.advance(60_000); return false; } };
    await expect(respond(p, final.id, "accept", service(p, { holds: delayed }))).rejects.toMatchObject({ code: "not_authorized" });
    expect((await order(p)).state).toBe("delivered");
  });
  test.each(["scanning", "foreign", "context", "missing"] as const)("invalid %s attachments roll back submission, supersession and entry", async (kind) => {
    const p = await fixture.paidOrder(); const draft = await submit(p); const command = await submitCommand(p, "final");
    const bad = kind === "missing" ? randomUUID() : await cleanFile(p, kind === "scanning" ? { state: "scanning" }
      : kind === "foreign" ? { ownerUserId: p.buyer.userId } : { context: "thread" });
    await expect(service(p).submit({ ...command, fileIds: [...command.fileIds, bad] })).rejects.toMatchObject({ code: "invalid_attachment_files" });
    expect(await submissions(p)).toHaveLength(1); expect((await submissions(p))[0]!.response).toBeNull();
    expect((await fixture.db.select().from(schema.commissionFiles).where(eq(schema.commissionFiles.id, command.fileIds[0]!)))[0]!.state).toBe("clean");
    expect((await service(p).getThread({ actor: p.buyer, orderId: p.orderId })).items.map((item) => item.id)).toEqual([draft.id]);
  });
  test("submission validation bounds files and notes, and change requests require a note", async () => {
    const p = await fixture.paidOrder(); const command = await submitCommand(p);
    for (const fileIds of [[], [command.fileIds[0], command.fileIds[0]], ["invalid"], Array.from({ length: 21 }, () => randomUUID())])
      await expect(service(p).submit({ ...command, fileIds })).rejects.toMatchObject({ code: "invalid_request" });
    for (const note of ["😀".repeat(2_001), "\u202e", 123]) await expect(service(p).submit({ ...command, note })).rejects.toMatchObject({ code: "invalid_request" });
    await service(p).submit({ ...command, note: "😀".repeat(2_000) }); const draft = (await submissions(p))[0]!;
    for (const note of [undefined, "   ", "😀".repeat(2_001)]) await expect(service(p).respondToSubmission({ ...await responseCommand(p, draft.id, "request_changes"), note })).rejects.toMatchObject({ code: "invalid_request" });
    const empty = await submitCommand(p); await service(p).submit({ ...empty, note: "   " });
    expect((await submissions(p)).find((row) => row.requestId === empty.requestId)!.noteEnvelope).toBeNull();
  });
});

describe("commission fulfillment projections and thread access", () => {
  test("thread merges messages and submissions by sequence and pages beforeSequence", async () => {
    const p = await fixture.paidOrder(); const thread = createCommissionThreadPort({ keyring: p.s.input.keyring, mode: "enabled" });
    const files = vi.spyOn(thread, "describeAttachedFiles");
    const messages = createCommissionThreadService({ ...p.s.input, filesMode: "enabled", fulfillmentMode: "enabled", sessions: p.s.input.identity,
      orders: createCommissionFileAccessPort({ catalog: p.s.catalog }) });
    const message = await messages.sendMessage({ actor: p.buyer, orderId: p.orderId, text: "Synthetic message <3", fileIds: [], ...commandIds() });
    p.s.creator.advance(1_000); const draft = await submit(p); const final = await submit(p, "final");
    const instance = service(p, { thread }); const view = await instance.getThread({ actor: p.buyer, orderId: p.orderId, limit: 2 });
    expect(view.items.map((item) => [item.sequence, item.kind, item.id])).toEqual([[3, "submission", final.id], [2, "submission", draft.id]]);
    expect(view.nextBeforeSequence).toBe(2); expect(view.writable).toBe(true); expect(files).toHaveBeenCalledTimes(1);
    expect(view.items.every((item) => item.kind !== "submission" || item.files.length === 1)).toBe(true);
    expect(view.items.map((item) => item.kind === "submission" && item.actionable)).toEqual([true, false]);
    const page = await instance.getThread({ actor: p.buyer, orderId: p.orderId, beforeSequence: view.nextBeforeSequence!, limit: 2 });
    expect(page.items.map((item) => [item.sequence, item.kind, item.id])).toEqual([[1, "message", message.messageId]]);
    expect(page.items[0]!.kind === "message" && page.items[0]!.text === "Synthetic message <3").toBe(true); expect(page.nextBeforeSequence).toBeNull();
    const creator = await instance.getThread({ actor: p.creator, orderId: p.orderId });
    expect(creator.items.every((item) => item.kind !== "submission" || !item.actionable)).toBe(true);
  });
  test("the owner account and a stranger get not_authorized", async () => {
    const p = await fixture.paidOrder(); const stranger = await p.s.buyer(); const owner = await p.s.buyer(); const at = p.s.creator.now();
    await fixture.db.insert(schema.identityRoleGrants).values({ id: randomUUID(), userId: owner.userId, role: "owner", grantSource: "bootstrap_cli", grantedAt: at, createdAt: at, updatedAt: at });
    for (const actor of [stranger, owner]) await expect(service(p).getThread({ actor, orderId: p.orderId })).rejects.toMatchObject({ code: "not_authorized" });
    await expect(service(p).getThread({ actor: { ...p.buyer, sessionId: "invalid-session" }, orderId: p.orderId })).rejects.toMatchObject({ code: "not_authorized" });
  });
  test("thread before in_progress returns invalid_transition", async () => {
    const s = await fixture.setup(); const orderId = await s.service.request(s.request());
    const instance = createCommissionOrderService({ ...s.input, fulfillmentMode: "enabled", thread: createCommissionThreadPort({ keyring: s.input.keyring, mode: "enabled" }) });
    await expect(instance.getThread({ actor: s.buyerActor, orderId })).rejects.toMatchObject({ code: "invalid_transition" });
    expect((await instance.getOrder({ actor: s.buyerActor, orderId })).fulfillment).toBeNull();
  });
  test("list projections distinguish open drafts, delivered, overdue and completed", async () => {
    const p = await fixture.paidOrder(); const instance = service(p);
    const list = () => instance.listOrders({ actor: p.creator, role: "creator" });
    expect((await list()).items[0]).toMatchObject({ awaitingBuyer: false, overdue: false, reviewEndsAt: null });
    const draft = await submit(p); expect((await list()).items[0]!.awaitingBuyer).toBe(true);
    await respond(p, draft.id, "approve"); expect((await list()).items[0]!.awaitingBuyer).toBe(false);
    p.s.creator.setNow(new Date((await order(p)).dueAt!.getTime() + 1)); expect((await list()).items[0]!.overdue).toBe(true);
    const final = await submit(p, "final"); expect((await list()).items[0]).toMatchObject({ awaitingBuyer: true, overdue: false, reviewEndsAt: (await order(p)).reviewEndsAt!.toISOString() });
    await respond(p, final.id, "accept"); expect((await list()).items[0]).toMatchObject({ awaitingBuyer: false, overdue: false });
  });
  test("after three completed orders the buyer can request again", async () => {
    const p = await fixture.paidOrder(); let current = p;
    for (let index = 0; index < 3; index++) {
      if (index > 0) {
        const orderId = await service(p).request(p.s.request()); const detail = await service(p).getOrder({ actor: p.buyer, orderId });
        const payments = createCreatorCommissionPaymentService({ ...p.s.creator.common, applicationRevision: "synthetic-i7", paymentsMode: "manual_only",
          recentAuthMs: 900_000, mfaAuthMs: 300_000, assurance: p.s.creator.assurance, commissions: p.service.paymentsLifecycle });
        await payments.confirm({ actor: p.creator, paymentIntentId: detail.payment!.id, observedAmountVnd: detail.payment!.amountVnd,
          observedTransferReference: detail.payment!.reference, observedBankTransactionId: randomUUID(), attestedReceived: true, ...commandIds() });
        current = { ...p, orderId };
      }
      const final = await submit(current, "final"); await respond(current, final.id, "accept");
    }
    await expect(service(p).request(p.s.request())).resolves.toEqual(expect.any(String));
    const rows = await fixture.db.select().from(schema.commissionOrders).where(and(eq(schema.commissionOrders.buyerUserId, p.buyer.userId), eq(schema.commissionOrders.creatorUserId, p.creator.userId)));
    expect(rows.filter((row) => row.state === "completed")).toHaveLength(3); expect(rows).toHaveLength(4);
  });
});
