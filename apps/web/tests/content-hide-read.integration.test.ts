import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createCommissionFileAttachmentPort, createCommissionFileService, createCommissionThreadPort, createCommissionThreadService, createThreadReportTargetPort, encryptCommissionFileName } from "@pawket/commission-files";
import { createCommissionPackageService } from "@pawket/catalog";
import { createCommissionFileAccessPort, createCommissionOrderService, createBriefReportTargetPort, lockCommissionCreator } from "@pawket/orders";
import { createContentHideReadPort, createContentHideService, createPrivateReportService, createTrustRestrictionPort, createTrustCaseService } from "@pawket/trust";
import { createCaseEvidencePort } from "../src/platform/case-evidence.js";
import { createCommissionHttpHandlers } from "../src/platform/commission-http.js";
import { createCommissionOrderTestFixture } from "./commission-order-test-support.js";
import { service, cleanFile, submit } from "./commission-resolution-test-support.js";
import { commandIds, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";

const f = createCommissionOrderTestFixture("i8hideread"); beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);
async function setup() {
  const p = await f.paidOrder(); const contentHides = createContentHideReadPort();
  const orders = service(p, { thread: createCommissionThreadPort({ keyring: p.s.input.keyring, mode: "enabled", contentHides }) });
  const thread = createCommissionThreadService({ ...p.s.creator.common, filesMode: "enabled", fulfillmentMode: "enabled", sessions: p.s.input.identity,
    orders: createCommissionFileAccessPort({ catalog: p.s.catalog }) });
  const fileId = await cleanFile(p, { context: "thread" });
  const send = (text: string, fileIds: string[] = []) => thread.sendMessage({ actor: p.creator, orderId: p.orderId, text, fileIds, ...commandIds() });
  const reports = createPrivateReportService({ ...p.s.creator.common, mode: "enabled", challengeKey: p.s.creator.common.lookupHmacKey,
    now: p.s.creator.now, restrictions: createTrustRestrictionPort({ mode: "enabled" }), targets: createThreadReportTargetPort(),
    policies: { readCurrentIds: async () => ({ communityRulesRevisionId: null, enforcementRevisionId: null }) } });
  async function report(target: { kind: "commission_message"; messageId: string } | { kind: "commission_file"; fileId: string }) {
    return reports.submit({ requester: { kind: "authenticated", actor: p.buyer }, target: { ...target, orderId: p.orderId }, reason: "other", detail: null, ...commandIds() });
  }
  const hides = createContentHideService({ ...p.s.creator.common, mode: "enabled", now: p.s.creator.now, consumeStepUpProof: async () => true,
    applicationRevision: "synthetic-hide", fence: { lockCreatorFence: lockCommissionCreator } });
  async function command(caseId: string) {
    const [row] = await f.db.select().from(schema.trustCases).where(eq(schema.trustCases.id, caseId));
    return { owner: p.creator, caseId, stepUpProofId: randomUUID(), expectedCaseVersion: row!.version, reason: "Private reason", ...commandIds() };
  }
  const storage = { presignDownload: vi.fn(async () => ({ url: "https://example.invalid/download", expiresAt: new Date() })), presignUpload: vi.fn() };
  const files = createCommissionFileService({ ...p.s.creator.common, storage, contentHides, mode: "enabled", fulfillmentMode: "enabled",
    sessions: p.s.input.identity, orders: createCommissionFileAccessPort({ catalog: p.s.catalog }) });
  const evidence = createCaseEvidencePort({ orders, files, catalog: p.s.catalog, contentHides, keyring: p.s.input.keyring,
    refunds: { listForOrder: vi.fn(), revealForCase: vi.fn() }, view: { readForCase: vi.fn() } });
  const cases = createTrustCaseService({ db: f.db, applicationRevision: "synthetic-hide", consumeStepUpProof: async () => true, evidence, now: p.s.creator.now });
  return { p, orders, send, fileId, report, hides, command, storage, files, cases };
}
test("hidden messages retain author/time for both parties and hidden files cannot be downloaded; owner evidence keeps originals", async () => {
  const c = await setup(); const message = await c.send("Private hidden original", [c.fileId]);
  const mr = await c.report({ kind: "commission_message", messageId: message.messageId }); const fr = await c.report({ kind: "commission_file", fileId: c.fileId });
  const mh = await c.hides.hide(await c.command(mr.caseId)); await c.hides.hide(await c.command(fr.caseId));
  for (const actor of [c.p.buyer, c.p.creator]) {
    const page = await c.orders.getThread({ actor, orderId: c.p.orderId });
    expect(JSON.parse(JSON.stringify(page)).items[0]).toMatchObject({ kind: "message", hidden: true, text: null, author: "creator", createdAt: c.p.s.creator.now().toISOString(), files: [{ availability: "hidden", previewable: false }] });
    await expect(c.files.downloadGrant({ actor, orderId: c.p.orderId, fileId: c.fileId, disposition: "attachment" })).rejects.toMatchObject({ code: "not_available" });
    const origin = "https://pawket.example.invalid";
    const http = createCommissionHttpHandlers({ appBaseUrl: origin, lookupHmacKey: c.p.s.creator.common.lookupHmacKey, intakeMode: "enabled", paymentsMode: "manual_only", fulfillmentMode: "enabled",
      authenticate: async () => actor, throttle: async () => true, orders: c.orders, catalog: c.p.s.catalog, manual: {} as Parameters<typeof createCommissionHttpHandlers>[0]["manual"] });
    const response = await http.thread(new Request(`${origin}/api/v1/commissions/${c.p.orderId}/thread`, { headers: { "x-real-ip": "127.0.0.1" } }), c.p.orderId, actor.userId === c.p.buyer.userId ? "buyer" : "creator");
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ thread: { items: [{ hidden: true, text: null, files: [{ availability: "hidden" }] }] } });
  }
  expect(c.storage.presignDownload).not.toHaveBeenCalled();
  const access = { owner: c.p.creator, stepUpProofId: randomUUID(), requestId: randomUUID(), caseId: fr.caseId };
  expect(await c.cases.fileGrant({ ...access, fileId: c.fileId, disposition: "attachment" })).toEqual({ url: "https://example.invalid/download" });
  const original = await c.cases.readEvidence({ ...access, section: "report_context" });
  expect(original).toMatchObject({ file: { fileId: c.fileId, hidden: true }, carrier: { kind: "message", text: "Private hidden original", hidden: true } });
  await c.hides.restore({ ...await c.command(mr.caseId), hideId: mh.hideId });
  expect((await c.orders.getThread({ actor: c.p.buyer, orderId: c.p.orderId })).items[0]).toMatchObject({ text: "Private hidden original", hidden: false });
}, 30_000);

test("package evidence retains the reported revision and logs reads; hide waits for intake's creator fence", async () => {
  const s = await f.setup(); const contentHides = createContentHideReadPort(); const at = s.creator.now;
  const catalog = createCommissionPackageService({ ...s.creator.common, applicationRevision: "synthetic-hide", intakeMode: "enabled", paymentsMode: "manual_only", publishingMode: "general_audience", contentHides,
    policy: s.input.policy, now: at, identity: { lockCreator: (tx, actor, now) => s.input.identity.getTipSessionAssurance(tx, actor, now) }, receivingAccount: { getCurrentTipReceivingAccount: async () => ({ accountVersionId: s.creator.accountVersionId }) },
    visibility: { resolveVisibleReportTarget: async (_tx, target) => ({ target, pageId: s.pageId, creatorUserId: s.creator.actor.userId, canonicalHandle: s.handle, displayName: "Artist", showcaseTitle: null, mediaAssetIds: [] }) } });
  const reports = createPrivateReportService({ ...s.creator.common, mode: "enabled", challengeKey: s.creator.common.lookupHmacKey, now: at,
    restrictions: createTrustRestrictionPort({ mode: "enabled" }), policies: { readCurrentIds: async () => ({ communityRulesRevisionId: null, enforcementRevisionId: null }) },
    targets: { resolve: async () => ({ kind: "commission_package", targetId: s.packageId, orderId: null, contentOwnerUserId: s.creator.actor.userId, packageRevisionId: s.revisionId }) } });
  const { caseId } = await reports.submit({ requester: { kind: "authenticated", actor: s.buyerActor }, target: { kind: "commission_package", packageId: s.packageId, revisionId: s.revisionId }, reason: "other", detail: null, ...commandIds() });
  await catalog.saveDraft({ actor: s.creator.actor, packageId: s.packageId, pageId: s.pageId, expectedVersion: 2, draft: { ...s.draft, title: "Later revision" }, ...commandIds() });
  await catalog.changePackage({ actor: s.creator.actor, packageId: s.packageId, expectedVersion: 3, action: "publish", policyRevisionId: s.policyId, ...commandIds() });
  let intakeEntered!: () => void; const entered = new Promise<void>((resolve) => { intakeEntered = resolve; });
  let releaseIntake!: () => void; const release = new Promise<void>((resolve) => { releaseIntake = resolve; });
  let hideStarted!: () => void; const started = new Promise<void>((resolve) => { hideStarted = resolve; }); const order: string[] = [];
  const intake = f.db.transaction(async (tx) => { await catalog.getIntakePackage(tx, { packageId: s.packageId, revisionId: s.revisionId, allowPreviousRevision: true, at: at() });
    order.push("intake_admitted"); intakeEntered(); await release; order.push("intake_committing"); });
  await entered;
  const hides = createContentHideService({ ...s.creator.common, mode: "enabled", applicationRevision: "synthetic-hide", now: at, consumeStepUpProof: async () => true,
    fence: { lockCreatorFence: async (tx, id) => { hideStarted(); await lockCommissionCreator(tx, id); order.push("hide_fence_acquired"); } } });
  const hide = hides.hide({ owner: s.creator.actor, caseId, expectedCaseVersion: 2, stepUpProofId: randomUUID(), reason: "Private reason", ...commandIds() });
  await started; releaseIntake(); await Promise.all([intake, hide]);
  expect(order).toEqual(["intake_admitted", "intake_committing", "hide_fence_acquired"]);
  await expect(f.db.transaction((tx) => catalog.getIntakePackage(tx, { packageId: s.packageId, revisionId: s.revisionId, allowPreviousRevision: true, at: at() }))).rejects.toMatchObject({ code: "not_available" });
  const evidence = createCaseEvidencePort({ catalog, contentHides, keyring: s.input.keyring, orders: s.service, files: { caseDownloadGrant: vi.fn() }, refunds: { listForOrder: vi.fn(), revealForCase: vi.fn() }, view: { readForCase: vi.fn() } });
  const cases = createTrustCaseService({ db: f.db, applicationRevision: "synthetic-hide", consumeStepUpProof: async () => true, evidence, now: at });
  const command = { owner: s.creator.actor, stepUpProofId: randomUUID(), requestId: randomUUID(), caseId };
  const revision = await cases.readEvidence({ ...command, section: "package_revision" });
  expect(revision).toMatchObject({ id: s.revisionId, title: "Portrait", hidden: true });
  expect(revision).not.toHaveProperty("actorSessionId"); expect(revision).not.toHaveProperty("creatorUserId");
  expect(await cases.readEvidence({ ...command, section: "report_context" })).toMatchObject({ revision: { id: s.revisionId, hidden: true } });
  expect(await f.db.select().from(schema.trustCaseAccessLog).where(eq(schema.trustCaseAccessLog.caseId, caseId))).toHaveLength(2);
}, 30_000);

test("brief evidence includes private text, links and reference files, with an access entry for each read", async () => {
  const s = await f.setup(); const files = createCommissionFileAttachmentPort({ keyring: s.input.keyring, mode: "enabled" });
  const fileId = randomUUID(); const at = s.creator.now();
  await f.db.insert(schema.commissionFiles).values({ id: fileId, ownerUserId: s.buyerActor.userId, context: "brief", packageId: s.packageId, declaredBytes: 16,
    filenameEnvelope: encryptCommissionFileName(s.input.keyring, fileId, "Reference artwork"), objectKey: `commission/${fileId}`, uploadExpiresAt: new Date(at.getTime() + 900_000), requestId: "synthetic", createdAt: at, updatedAt: at });
  await f.db.update(schema.commissionFiles).set({ state: "scanning", uploadedAt: at, scanDeadlineAt: new Date(at.getTime() + 86_400_000), version: 2 }).where(eq(schema.commissionFiles.id, fileId));
  await f.db.update(schema.commissionFiles).set({ state: "clean", sha256: `sha256:${"d".repeat(64)}`, detectedType: "png", cleanVersionId: "c", cleanAt: at, version: 3 }).where(eq(schema.commissionFiles.id, fileId));
  const orders = createCommissionOrderService({ ...s.input, files }); const orderId = await orders.request({ ...s.request(), referenceFileIds: [fileId] });
  const reports = createPrivateReportService({ ...s.creator.common, mode: "enabled", challengeKey: s.creator.common.lookupHmacKey, now: s.creator.now, targets: createBriefReportTargetPort(),
    restrictions: createTrustRestrictionPort({ mode: "enabled" }), policies: { readCurrentIds: async () => ({ communityRulesRevisionId: null, enforcementRevisionId: null }) } });
  const { caseId } = await reports.submit({ requester: { kind: "authenticated", actor: s.creator.actor }, target: { kind: "commission_brief", orderId }, reason: "other", detail: null, ...commandIds() });
  const evidence = createCaseEvidencePort({ orders, keyring: s.input.keyring, files: { caseDownloadGrant: vi.fn() }, refunds: { listForOrder: vi.fn(), revealForCase: vi.fn() }, view: { readForCase: vi.fn() } });
  const cases = createTrustCaseService({ db: f.db, applicationRevision: "synthetic-hide", consumeStepUpProof: async () => true, evidence, now: s.creator.now });
  const command = { owner: s.creator.actor, stepUpProofId: randomUUID(), requestId: randomUUID(), caseId };
  expect(await cases.readEvidence({ ...command, section: "brief" })).toMatchObject({ text: "Private commission brief", referenceLinks: ["https://example.invalid/reference"], referenceFiles: [{ fileId, name: "Reference artwork" }], hidden: false });
  expect(await cases.readEvidence({ ...command, section: "report_context" })).toMatchObject({ brief: { referenceFiles: [{ fileId }] } });
  expect(await f.db.select().from(schema.trustCaseAccessLog).where(eq(schema.trustCaseAccessLog.caseId, caseId))).toHaveLength(2);
}, 30_000);
test("report_context returns exactly 20 messages each side by sequence and logs access", async () => {
  const c = await setup(); const messages = [];
  for (let i = 0; i < 51; i++) {
    if (i === 10 || i === 30) await submit(c.p, "draft", c.orders);
    messages.push(await c.send(`Context ${i}`));
  }
  const { caseId } = await c.report({ kind: "commission_message", messageId: messages[25]!.messageId });
  await c.hides.hide(await c.command(caseId));
  const context = await c.cases.readEvidence({ owner: c.p.creator, stepUpProofId: randomUUID(), requestId: randomUUID(), caseId, section: "report_context" }) as { messages: { id: string; sequence: number; hidden: boolean; text: string | null }[] };
  expect(context.messages).toHaveLength(41); expect(context.messages.map((row) => row.sequence)).toEqual(messages.slice(5, 46).map((row) => row.sequence));
  expect(context.messages[20]).toMatchObject({ id: messages[25]!.messageId, hidden: true, text: "Context 25" });
  expect(await f.db.select().from(schema.trustCaseAccessLog).where(eq(schema.trustCaseAccessLog.caseId, caseId))).toMatchObject([{ itemType: "report_context", ownerUserId: c.p.creator.userId }]);
}, 30_000);

test("file evidence includes its submission carrier and owner downloads stop when the report case closes", async () => {
  const c = await setup(); const submission = await submit(c.p, "draft", c.orders);
  const [attachment] = await f.db.select().from(schema.commissionFileAttachments).where(eq(schema.commissionFileAttachments.targetId, submission.id));
  const fileId = attachment!.fileId; const { caseId } = await c.report({ kind: "commission_file", fileId });
  await c.hides.hide(await c.command(caseId));
  const access = { owner: c.p.creator, stepUpProofId: randomUUID(), requestId: randomUUID(), caseId };
  expect(await c.cases.readEvidence({ ...access, section: "report_context" })).toMatchObject({ file: { fileId, hidden: true }, carrier: { kind: "submission", id: submission.id, note: "Synthetic note <3" } });
  await c.hides.closeReportCase({ ...await c.command(caseId), resolution: "actioned" });
  await expect(c.cases.fileGrant({ ...access, fileId, disposition: "attachment" })).rejects.toMatchObject({ code: "not_available" });
  expect(c.storage.presignDownload).not.toHaveBeenCalled();
  expect(await f.db.select().from(schema.trustCaseAccessLog).where(eq(schema.trustCaseAccessLog.caseId, caseId))).toHaveLength(1);
}, 30_000);
