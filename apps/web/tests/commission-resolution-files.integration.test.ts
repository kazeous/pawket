import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import * as files from "@pawket/commission-files";
import { createCommissionFileAccessPort, createCommissionResolutionOrderPort, lockCommissionCreator } from "@pawket/orders";
import { createCommissionPaymentFactsPort, createCommissionRefundPort, createCommissionRefundService } from "@pawket/payments";
import * as resolutions from "@pawket/resolutions";
import { createCaseEvidenceHoldPort, createTrustCasePort } from "@pawket/trust";
import { createCommissionFileHttpHandlers } from "../src/platform/commission-file-http.js";
import { createCommissionResolutionTestFixture, service, submit, respond, cleanFile } from "./commission-resolution-test-support.js";
import { commandIds, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";

const f = createCommissionResolutionTestFixture("i8files");
beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);
const DAY = 86_400_000; const calendarVersion = "vn-proposals-test";
type Context = Readonly<{ s: Awaited<ReturnType<typeof f.setup>>; orderId: string; buyer: { userId: string; sessionId: string }; creator: { userId: string; sessionId: string } }>;
const orderPort = () => createCommissionResolutionOrderPort({ applicationRevision: "synthetic-i8", newId: randomUUID });
const order = (p: Context) => f.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, p.orderId)).then((rows) => rows[0]!);
const file = (fileId: string) => f.db.select().from(schema.commissionFiles).where(eq(schema.commissionFiles.id, fileId)).then((rows) => rows[0]!);
const refundPort = (p: Context) => createCommissionRefundPort({ keyring: p.s.input.keyring, calendarVersion });
const evidencePort = (p: Context, mode: "enabled" | "disabled" = "enabled") => files.createCommissionEvidenceAttachmentPort({ keyring: p.s.input.keyring, mode });
const uploadPort = (p: Context, mode: "enabled" | "disabled" = "enabled") => resolutions.createCommissionEvidenceUploadPort({
  orders: orderPort(), refunds: refundPort(p), payments: createCommissionPaymentFactsPort(), mode, now: p.s.creator.now,
});
function fileService(p: Context, evidence = false) {
  const storage = { presignUpload: vi.fn(async () => ({ url: "https://example.invalid/upload", requiredHeaders: {}, expiresAt: new Date(p.s.creator.now().getTime() + 900_000) })),
    presignDownload: vi.fn(async () => ({ url: "https://example.invalid/download", expiresAt: new Date(p.s.creator.now().getTime() + 300_000) })) };
  return { storage, instance: files.createCommissionFileService({ ...p.s.creator.common, storage, mode: "enabled", fulfillmentMode: "enabled",
    sessions: p.s.input.identity, orders: createCommissionFileAccessPort({ catalog: p.s.catalog }), ...(evidence ? { evidenceUploads: uploadPort(p) } : {}) }) };
}
const uploadCommand = (p: Context, actor = p.creator, declaredBytes = 16) => ({ actor, context: "resolution_evidence" as const,
  orderId: p.orderId, fileName: "Synthetic evidence", declaredBytes, ...commandIds() });
async function markClean(p: Context, id: string, detectedType = "png") {
  const current = await file(id); const at = p.s.creator.now();
  await f.db.update(schema.commissionFiles).set({ state: "clean", sha256: `sha256:${"d".repeat(64)}`, detectedType,
    quarantineVersionId: "q", cleanVersionId: "c", cleanAt: at, version: current.version + 1, updatedAt: at }).where(eq(schema.commissionFiles.id, id));
}
async function evidenceFile(p: Context, actor = p.creator) {
  const { instance } = fileService(p, true); const { fileId } = await instance.createUpload(uploadCommand(p, actor));
  expect((await instance.completeUpload({ actor, fileId, requestId: randomUUID() })).state).toBe("scanning");
  await markClean(p, fileId); return fileId;
}
async function closePaid(p: Context) {
  const current = await order(p);
  await f.db.transaction((tx) => orderPort().closePaidOrder(tx, { orderId: p.orderId, expectedVersion: current.version,
    reason: "cancelled_by_agreement", actor: p.buyer, requestId: randomUUID(), at: p.s.creator.now() }));
}
async function closedUnpaid() {
  const s = await f.setup(); const orderId = await s.service.request(s.request());
  const p = { s, orderId, buyer: s.buyerActor, creator: s.creator.actor };
  s.creator.setNow((await order(p)).expiresAt!); await s.service.expireDue(); return p;
}
function claims(p: Context, mode: "enabled" | "disabled" = "enabled") {
  return resolutions.createLateClaimService(resolutions.createResolutionCommandKit({ ...p.s.creator.common, session: p.s.input.identity }), {
    orders: orderPort(), refunds: refundPort(p), payments: createCommissionPaymentFactsPort(), cases: createTrustCasePort(), files: evidencePort(p), mode,
  });
}
const filing = (p: Context, fileIds: readonly string[]) => ({ actor: p.buyer, orderId: p.orderId, transferAt: p.s.creator.now(),
  amountVnd: 500_000, bankReference: "SYNTHETIC_REF", fileIds, ...commandIds() });
async function awaitingSend(existing?: Awaited<ReturnType<typeof f.paidOrder>>) {
  const p = existing ?? await f.paidOrder();
  await closePaid(p);
  const { obligationId } = await f.db.transaction((tx) => refundPort(p).createObligation(tx, { orderId: p.orderId,
    paymentIntentId: p.confirmationCommand.paymentIntentId, creatorUserId: p.creator.userId, buyerUserId: p.buyer.userId,
    source: "agreement", sourceId: randomUUID(), amountVnd: 500_000, requestId: randomUUID(), at: p.s.creator.now() }));
  const instance = createCommissionRefundService({ ...p.s.creator.common, applicationRevision: "synthetic-i8", calendarVersion, mode: "enabled",
    recentAuthMs: 3_600_000, mfaAuthMs: 300_000, lockCreator: lockCommissionCreator, cases: createTrustCasePort(), files: evidencePort(p),
    assurance: { getTipSessionAssurance: async (_tx, actor, at) => p.s.users.get(actor.userId) === actor.sessionId
      ? { primaryAuthenticatedAt: at, mfaEnrolled: false, mfaVerifiedAt: null, sessionExpiresAt: new Date(at.getTime() + 60_000) } : null } });
  await instance.enterDestination({ actor: p.buyer, obligationId, expectedVersion: 1, bankBin: "970422",
    accountNumber: "000000123456", accountHolder: "SYNTHETIC BUYER", ...commandIds() });
  const sending = (fileIds: readonly string[]) => ({ actor: p.creator, obligationId, expectedVersion: 2, transferDate: "2026-09-26",
    bankReference: "SYNTHETIC_REF", fileIds, ...commandIds() });
  return { p, instance, sending };
}

test("the creator uploads an evidence image for an awaiting_send obligation and attaches it when recording the send; it counts toward the 1 GiB quota", async () => {
  const c = await awaitingSend(); const fileId = await evidenceFile(c.p); const command = c.sending([fileId]);
  const usage = () => f.db.execute(sql`select commission_order_file_bytes(${c.p.orderId}::uuid) as bytes`).then((rows) => Number(rows[0]!.bytes));
  expect(await usage()).toBe(16);
  for (let index = 0; index < 4; index++) {
    const id = randomUUID(); const at = c.p.s.creator.now();
    await f.db.insert(schema.commissionFiles).values({ id, ownerUserId: c.p.creator.userId, context: "submission", uploadOrderId: c.p.orderId,
      declaredBytes: 262_144_000, filenameEnvelope: files.encryptCommissionFileName(c.p.s.input.keyring, id, "Synthetic artwork"),
      objectKey: `commission/${id}`, uploadExpiresAt: new Date(at.getTime() + 900_000), requestId: "quota-fixture", createdAt: at, updatedAt: at });
  }
  const bytes = await usage();
  await expect(fileService(c.p, true).instance.createUpload(uploadCommand(c.p, c.p.creator, 26_214_400))).rejects.toMatchObject({ code: "order_quota_exceeded" });
  expect(await c.instance.recordSend(command)).toEqual({ version: 3 });
  expect(await c.instance.recordSend(command)).toEqual({ version: 3 }); expect(await usage()).toBe(bytes);
  expect(await file(fileId)).toMatchObject({ state: "attached", orderId: c.p.orderId });
  const [attachment] = await f.db.select().from(schema.commissionFileAttachments).where(eq(schema.commissionFileAttachments.fileId, fileId));
  expect(attachment).toMatchObject({ targetKind: "refund_send", position: 0 });
  const [send] = await f.db.select().from(schema.commissionRefundSends).where(eq(schema.commissionRefundSends.id, attachment!.targetId));
  expect(send?.obligationId).toBe(command.obligationId);
});

test("upload without an eligible obligation or claim is refused", async () => {
  const p = await f.paidOrder(); const { instance } = fileService(p, true); const outsider = await p.s.buyer();
  for (const actor of [p.creator, p.buyer]) await expect(instance.createUpload(uploadCommand(p, actor))).rejects.toMatchObject({ code: "invalid_state" });
  await expect(instance.createUpload(uploadCommand(p, outsider))).rejects.toMatchObject({ code: "not_available" });
  await expect(fileService(p).instance.createUpload(uploadCommand(p))).rejects.toMatchObject({ code: "invalid_state" });
  const c = await awaitingSend();
  await expect(fileService(c.p, true).instance.createUpload(uploadCommand(c.p, c.p.buyer))).rejects.toMatchObject({ code: "invalid_state" });
  expect(await f.db.transaction((tx) => uploadPort(c.p, "disabled").canUpload(tx, { orderId: c.p.orderId, actorUserId: c.p.creator.userId }))).toBe(false);
});

test("the buyer attaches up to three scanned evidence files to a late claim and cannot upload after filing", async () => {
  const p = await closedUnpaid(); const ids = await Promise.all(Array.from({ length: 3 }, () => evidenceFile(p, p.buyer)));
  const instance = claims(p); const command = filing(p, ids); const { claimId } = await instance.fileLateClaim(command);
  expect(await instance.fileLateClaim(command)).toEqual({ claimId });
  expect(await f.db.select().from(schema.commissionFileAttachments).where(and(eq(schema.commissionFileAttachments.orderId, p.orderId), eq(schema.commissionFileAttachments.targetId, claimId))))
    .toEqual(expect.arrayContaining(ids.map((fileId, position) => expect.objectContaining({ fileId, targetKind: "late_claim", position }))));
  await expect(fileService(p, true).instance.createUpload(uploadCommand(p, p.buyer))).rejects.toMatchObject({ code: "invalid_state" });
});

test("invalid refund evidence rolls back the send and leaves clean files unattached", async () => {
  const c = await awaitingSend(); const valid = await evidenceFile(c.p);
  const other = await awaitingSend(); const foreign = await evidenceFile(other.p);
  const wrongContext = await cleanFile(c.p); const pending = await fileService(c.p, true).instance.createUpload(uploadCommand(c.p));
  for (const fileIds of [[randomUUID()], [foreign], [wrongContext], [pending.fileId], [valid, valid], [valid, randomUUID(), randomUUID(), randomUUID()]]) {
    await expect(c.instance.recordSend(c.sending(fileIds))).rejects.toMatchObject({ code: "invalid_request" });
    expect(await f.db.select().from(schema.commissionRefundSends).where(eq(schema.commissionRefundSends.obligationId, c.sending([]).obligationId))).toHaveLength(0);
    expect((await file(valid)).state).toBe("clean");
  }
  await c.instance.recordSend(c.sending([valid]));
  expect(await f.db.transaction((tx) => evidencePort(c.p).attachResolutionEvidence(tx, { orderId: c.p.orderId, ownerUserId: c.p.creator.userId,
    target: { kind: "refund_send", id: randomUUID() }, fileIds: [valid], at: c.p.s.creator.now() }))).toBe("invalid");
});

test("the database refuses refund evidence belonging to the buyer and a send on another order", async () => {
  const c = await awaitingSend(); const other = await awaitingSend();
  const valid = await evidenceFile(c.p); const ownSend = c.sending([]); await c.instance.recordSend(ownSend); await other.instance.recordSend(other.sending([]));
  const [own] = await f.db.select().from(schema.commissionRefundSends).where(eq(schema.commissionRefundSends.obligationId, ownSend.obligationId));
  const [foreign] = await f.db.select().from(schema.commissionRefundSends).where(eq(schema.commissionRefundSends.obligationId, other.sending([]).obligationId));
  const id = randomUUID(); const at = c.p.s.creator.now();
  await f.db.insert(schema.commissionFiles).values({ id, ownerUserId: c.p.buyer.userId, context: "resolution_evidence", uploadOrderId: c.p.orderId,
    declaredBytes: 16, filenameEnvelope: files.encryptCommissionFileName(c.p.s.input.keyring, id, "Synthetic evidence"), objectKey: `commission/${id}`,
    uploadExpiresAt: new Date(at.getTime() + 900_000), requestId: "fixture", createdAt: at, updatedAt: at });
  await fileService(c.p).instance.completeUpload({ actor: c.p.buyer, fileId: id, requestId: randomUUID() }); await markClean(c.p, id);
  for (const [fileId, targetId] of [[id, own!.id], [valid, foreign!.id]]) {
    let rejected = false;
    try { await f.db.transaction(async (tx) => {
      await tx.update(schema.commissionFiles).set({ state: "attached", orderId: c.p.orderId, attachedAt: at, version: 4, updatedAt: at }).where(eq(schema.commissionFiles.id, fileId!));
      await tx.insert(schema.commissionFileAttachments).values({ fileId: fileId!, orderId: c.p.orderId, targetKind: "refund_send", targetId: targetId!, position: 0, attachedAt: at });
    }); } catch (error) { expect((error as { cause?: unknown }).cause ?? error).toMatchObject({ code: "23514" }); rejected = true; }
    expect(rejected).toBe(true); expect((await file(fileId!)).state).toBe("clean");
  }
});

test("buyer evidence upload uses the effective claim window, including its boundary and pause grace", async () => {
  const p = await closedUnpaid(); const closedAt = (await order(p)).closedAt!; const port = uploadPort(p);
  const allowed = () => f.db.transaction((tx) => port.canUpload(tx, { orderId: p.orderId, actorUserId: p.buyer.userId }));
  p.s.creator.setNow(new Date(closedAt.getTime() + 30 * DAY)); expect(await allowed()).toBe(true);
  p.s.creator.advance(1); expect(await allowed()).toBe(false);
  const pauseId = randomUUID(); const startedAt = new Date(closedAt.getTime() + 29 * DAY); const endedAt = new Date(closedAt.getTime() + 31 * DAY);
  await f.db.insert(schema.commissionResolutionPauses).values({ id: pauseId, startedAt });
  try { expect(await allowed()).toBe(false); }
  finally { await f.db.update(schema.commissionResolutionPauses).set({ endedAt, version: 2 }).where(eq(schema.commissionResolutionPauses.id, pauseId)); }
  p.s.creator.setNow(new Date(endedAt.getTime() + 2 * DAY)); expect(await allowed()).toBe(true);
  p.s.creator.advance(1); expect(await allowed()).toBe(false);
});

async function threadFiles(p: Awaited<ReturnType<typeof f.paidOrder>>) {
  const thread = files.createCommissionThreadService({ ...p.s.creator.common, filesMode: "enabled", fulfillmentMode: "enabled",
    sessions: p.s.input.identity, orders: createCommissionFileAccessPort({ catalog: p.s.catalog }) });
  const buyerFile = await cleanFile(p, { context: "thread", ownerUserId: p.buyer.userId });
  const creatorFile = await cleanFile(p, { context: "thread" });
  for (const [actor, fileId] of [[p.buyer, buyerFile], [p.creator, creatorFile]] as const) await thread.sendMessage({ actor, orderId: p.orderId, text: "Synthetic text", fileIds: [fileId], ...commandIds() });
  const briefId = randomUUID(); const at = p.s.creator.now();
  await f.db.insert(schema.commissionFiles).values({ id: briefId, ownerUserId: p.buyer.userId, context: "brief", packageId: p.s.packageId,
    declaredBytes: 16, filenameEnvelope: files.encryptCommissionFileName(p.s.input.keyring, briefId, "Synthetic reference"), objectKey: `commission/${briefId}`,
    uploadExpiresAt: new Date(at.getTime() + 900_000), requestId: "fixture", createdAt: at, updatedAt: at });
  await fileService(p).instance.completeUpload({ actor: p.buyer, fileId: briefId, requestId: randomUUID() }); await markClean(p, briefId);
  await f.db.transaction((tx) => files.createCommissionFileAttachmentPort({ keyring: p.s.input.keyring, mode: "enabled" }).attachBriefFiles(tx, {
    orderId: p.orderId, buyerUserId: p.buyer.userId, packageId: p.s.packageId, fileIds: [briefId], at }));
  const draft = await submit(p, "draft");
  const [attached] = await f.db.select().from(schema.commissionFileAttachments).where(eq(schema.commissionFileAttachments.targetId, draft.id));
  return { thread, buyerFiles: [buyerFile, briefId], creatorFiles: [creatorFile, attached!.fileId] };
}

test("after a paid close the buyer downloads their own thread attachment and brief reference, is refused every creator file, and the creator downloads everything", async () => {
  const p = await f.paidOrder(); const attached = await threadFiles(p); const c = await awaitingSend(p);
  const evidence = await evidenceFile(p); await c.instance.recordSend(c.sending([evidence])); attached.creatorFiles.push(evidence);
  const { instance, storage } = fileService(p);
  for (const actor of [p.buyer, p.creator]) for (const fileId of [...attached.buyerFiles, ...attached.creatorFiles]) {
    const command = { actor, orderId: p.orderId, fileId, disposition: "attachment" as const };
    if (actor === p.buyer && attached.creatorFiles.includes(fileId)) {
      const calls = storage.presignDownload.mock.calls.length; await expect(instance.downloadGrant(command)).rejects.toMatchObject({ code: "not_available" });
      expect(storage.presignDownload).toHaveBeenCalledTimes(calls);
      await expect(instance.downloadGrant({ ...command, disposition: "inline" })).rejects.toMatchObject({ code: "not_available" });
    } else expect((await instance.downloadGrant(command)).url !== undefined).toBe(true);
  }
});

test("after a paid completion the buyer keeps creator files", async () => {
  const p = await f.paidOrder(); const attached = await threadFiles(p); const final = await submit(p, "final"); await respond(p, final.id, "accept");
  const [finalFile] = await f.db.select().from(schema.commissionFileAttachments).where(eq(schema.commissionFileAttachments.targetId, final.id));
  attached.creatorFiles.push(finalFile!.fileId);
  const { instance } = fileService(p);
  for (const fileId of attached.creatorFiles) expect((await instance.downloadGrant({ actor: p.buyer, orderId: p.orderId, fileId, disposition: "attachment" })).url !== undefined).toBe(true);
});

test.each([false, true])("both parties read the paid-close thread without actionable submissions and cannot send messages (delivered=%s)", async (delivered) => {
  const p = await f.paidOrder(); const attached = await threadFiles(p); if (delivered) await submit(p, "final"); await closePaid(p);
  for (const actor of [p.buyer, p.creator]) {
    const view = await service(p).getThread({ actor, orderId: p.orderId });
    expect(view.writable).toBe(false); expect(view.items).toHaveLength(delivered ? 4 : 3);
    expect(view.items.filter((item) => item.kind === "submission").every((item) => !item.actionable)).toBe(true);
    await expect(attached.thread.sendMessage({ actor, orderId: p.orderId, text: "Synthetic text", fileIds: [], ...commandIds() })).rejects.toMatchObject({ code: "invalid_state" });
  }
});

test("an evidence upload grant replay is refused once its obligation no longer awaits a send", async () => {
  const c = await awaitingSend(); const { instance } = fileService(c.p, true); const command = uploadCommand(c.p);
  await instance.createUpload(command); await c.instance.recordSend(c.sending([]));
  await expect(instance.createUpload(command)).rejects.toMatchObject({ code: "invalid_state" });
});

async function retention(p: Context, at: Date) {
  const port = createCommissionFileAccessPort({ catalog: p.s.catalog }); const storage = { deleteAllVersions: vi.fn(async () => 0) };
  const report = await files.runCommissionFileMaintenance({ db: f.db, storage,
    orders: { retentionFacts: async (db) => port.retentionFacts(db, [p.orderId]) }, holds: createCaseEvidenceHoldPort({ now: () => at }),
    retentionMode: "report_only", batchSize: 500, enqueueScan: async () => undefined, now: () => at });
  return report.retentionDue;
}
test("files of an order closed after payment become due 180 days after closedAt", async () => {
  const p = await f.paidOrder(); const attached = await threadFiles(p); await closePaid(p); const at = p.s.creator.now();
  expect(await retention(p, new Date(at.getTime() + 180 * DAY - 1))).toBe(0);
  expect(await retention(p, new Date(at.getTime() + 180 * DAY))).toBe(4);
  for (const fileId of [...attached.buyerFiles, ...attached.creatorFiles]) expect((await file(fileId)).state).toBe("attached");
});
test("an evidence hold keeps them until 30 days after the last case resolved", async () => {
  const p = await f.paidOrder(); await threadFiles(p); await closePaid(p); const at = p.s.creator.now(); const cases = createTrustCasePort();
  const caseIds: string[] = [];
  for (const day of [180, 190]) {
    const { caseId } = await f.db.transaction((tx) => cases.openCase(tx, { kind: "dispute", orderId: p.orderId, sourceType: "commission_dispute",
      sourceId: randomUUID(), policyRevisionId: null, requestId: randomUUID(), at: new Date(at.getTime() + day * DAY) })); caseIds.push(caseId);
  }
  expect(await retention(p, new Date(at.getTime() + 200 * DAY))).toBe(0);
  for (const [index, caseId] of caseIds.entries()) await f.db.transaction((tx) => cases.resolveCase(tx, { caseId, resolutionKind: "withdrawn",
    actor: null, reason: null, requestId: randomUUID(), at: new Date(at.getTime() + (180 + index * 10) * DAY) }));
  expect(await retention(p, new Date(at.getTime() + 220 * DAY - 1))).toBe(0);
  expect(await retention(p, new Date(at.getTime() + 220 * DAY))).toBe(4);
});

test("the upload HTTP adapter accepts the evidence context", async () => {
  const c = await awaitingSend(); const { instance } = fileService(c.p, true);
  const http = createCommissionFileHttpHandlers({ appBaseUrl: "https://example.invalid", lookupHmacKey: c.p.s.input.lookupHmacKey,
    authenticate: async () => c.p.creator, throttle: async () => true, files: instance });
  const command = uploadCommand(c.p); const response = await http.createUpload(new Request("https://example.invalid/api/v1/commission-files", {
    method: "POST", headers: { origin: "https://example.invalid", "content-type": "application/json", "idempotency-key": randomUUID(), "x-real-ip": "203.0.113.5" },
    body: JSON.stringify({ context: command.context, orderId: command.orderId, fileName: command.fileName, declaredBytes: command.declaredBytes }) }));
  expect(response.status).toBe(200); expect((await response.json()).upload.fileId).toBeDefined();
});
