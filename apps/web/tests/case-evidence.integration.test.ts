import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createCommissionFileService } from "@pawket/commission-files";
import { createCreatorStandingPort, hashSessionToken, resolveSessionCookie } from "@pawket/identity";
import * as config from "@pawket/config";
import * as database from "@pawket/database";
import * as resolutions from "@pawket/resolutions";
import { createCommissionFileAccessPort, createCommissionResolutionOrderPort, lockCommissionCreator } from "@pawket/orders";
import { createCommissionPaymentFactsPort, createCommissionRefundPort, createCommissionRefundService } from "@pawket/payments";
import { createDisputeService, createOwnerResolutionService, createResolutionCommandKit, createResolutionViewService } from "@pawket/resolutions";
import { createTrustCasePort, createTrustCaseService } from "@pawket/trust";
import { createCaseEvidencePort } from "../src/platform/case-evidence.js";
import { createCaseHttpHandlers } from "../src/platform/case-http.js";
import { getPlatformRuntime } from "../src/platform/runtime.js";
import { caseDetailSchema } from "../src/ui/cases/case-client.js";
import { attachSyntheticOidcSession, syntheticOidcProvider } from "./oidc-test-support.js";
import { createCommissionResolutionTestFixture, service, submit, resolutionRefundDeadlines } from "./commission-resolution-test-support.js";
import { commandIds, fixtureKey, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";

const f = createCommissionResolutionTestFixture("i8caseevidence"); beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);
type Paid = Awaited<ReturnType<typeof f.paidOrder>>;
const order = (p: Paid) => f.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, p.orderId)).then((rows) => rows[0]!);
const accesses = (caseId: string) => f.db.select().from(schema.trustCaseAccessLog).where(eq(schema.trustCaseAccessLog.caseId, caseId));
async function setup() {
  const p = await f.deliveredOrder(); const actor = await p.s.buyer(); const cases = createTrustCasePort();
  const orders = service(p); const orderPort = createCommissionResolutionOrderPort({ applicationRevision: "synthetic-i8", newId: randomUUID });
  const refunds = createCommissionRefundPort({ keyring: p.s.input.keyring, calendarVersion: "vn-proposals-test" });
  const kit = createResolutionCommandKit({ ...p.s.creator.common, session: p.s.input.identity, consumeStepUpProof: async (_tx, input) => input.userId === actor.userId && input.sessionId === actor.sessionId,
    authorizeCommand: async (_tx, input) => { if (input.userId !== actor.userId) throw new Error("Synthetic forbidden owner"); } });
  const parties = createCommissionRefundService({ ...p.s.creator.common, applicationRevision: "synthetic-i8", calendarVersion: "vn-proposals-test", mode: "enabled",
    recentAuthMs: 3_600_000, mfaAuthMs: 300_000, lockCreator: lockCommissionCreator, cases, ...resolutionRefundDeadlines,
    assurance: { getTipSessionAssurance: async (_tx, input, at) => p.s.users.get(input.userId) === input.sessionId
      ? { primaryAuthenticatedAt: at, mfaEnrolled: false, mfaVerifiedAt: null, sessionExpiresAt: new Date(at.getTime() + 60_000) } : null } });
  const view = createResolutionViewService({ db: f.db, keyring: p.s.input.keyring, orders: { ...orderPort, listOrders: orders.listOrders }, refunds: parties, session: p.s.input.identity, now: p.s.creator.now });
  const storage = { presignDownload: vi.fn(async () => ({ url: "https://example.invalid/download", expiresAt: new Date() })), presignUpload: vi.fn() };
  const files = createCommissionFileService({ ...p.s.creator.common, storage, mode: "enabled", fulfillmentMode: "enabled", sessions: p.s.input.identity, orders: createCommissionFileAccessPort({ catalog: p.s.catalog }) });
  const instance = createTrustCaseService({ db: f.db, applicationRevision: "synthetic-i8", consumeStepUpProof: async (_tx, input) => input.userId === actor.userId && input.sessionId === actor.sessionId,
    deadlines: resolutions.createResolutionCaseDeadlinePort({ refunds }),
    evidence: createCaseEvidencePort({ orders, refunds, view, files }), now: p.s.creator.now });
  const disputes = createDisputeService(createResolutionCommandKit({ ...p.s.creator.common, session: p.s.input.identity }), { orders: orderPort, refunds, cases, mode: "enabled" });
  const opened = await disputes.openDispute({ actor: p.buyer, orderId: p.orderId, expectedVersion: (await order(p)).version, reason: "not_as_agreed", statement: "Synthetic statement",
    requestedOutcome: { kind: "close", refundAmountVnd: 100_000 }, acknowledgeStaffReview: true, ...commandIds() });
  await disputes.addStatement({ actor: p.creator, disputeId: opened.disputeId, text: "Synthetic response", ...commandIds() });
  const owner = createOwnerResolutionService(kit, { orders: orderPort, refunds, payments: createCommissionPaymentFactsPort(), cases, mode: "enabled", applicationRevision: "synthetic-i8", standing: createCreatorStandingPort() });
  const base = () => ({ owner: actor, stepUpProofId: randomUUID(), ...commandIds() });
  const access = () => ({ owner: actor, stepUpProofId: randomUUID(), requestId: randomUUID() });
  const read = (section: "order_summary" | "thread_page" | "resolution_records" | "refund_destination", caseId = opened.caseId) => instance.readEvidence({ ...access(), caseId, section });
  const rule = () => owner.rule({ ...base(), disputeId: opened.disputeId, outcome: "close", refundAmountVnd: 100_000, reasoning: "Synthetic public ruling" });
  return { p, ...opened, actor, instance, owner, base, access, read, rule, cases, refunds, parties, view, orders, storage };
}
test("the owner reads a dispute case's order summary, thread page and resolution records, each logged", async () => {
  const c = await setup(); const summary = await c.read("order_summary") as Awaited<ReturnType<typeof c.orders.readOrderForCase>>;
  expect(summary.id).toBe(c.p.orderId); expect(summary.brief.text === "Private commission brief").toBe(true);
  const page = await c.read("thread_page") as Awaited<ReturnType<typeof c.orders.readThreadForCase>>; expect(page.items).toHaveLength(1); expect(page.writable).toBe(false);
  expect(page.items.some((item) => item.kind === "submission" && item.actionable)).toBe(false);
  const records = await c.read("resolution_records") as { disputes: { id: string; statements: { text: string }[] }[]; refunds: unknown[] };
  expect(records.disputes[0]?.id).toBe(c.disputeId); expect(records.disputes[0]?.statements.length).toBe(2); expect(records.refunds).toEqual([]);
  const log = await accesses(c.caseId); expect(log.map((row) => row.itemType).sort()).toEqual(["order_summary", "resolution_records", "thread_page"]);
  expect(log.every((row) => row.ownerUserId === c.actor.userId && row.ownerSessionId === c.actor.sessionId)).toBe(true);
}, 30_000);
test("queue deadlines and owner ruling metadata use no private evidence or access-log write", async () => {
  const c = await setup(); const detail = await c.instance.getCase(c.caseId);
  const [dispute] = await f.db.select().from(schema.commissionDisputes).where(eq(schema.commissionDisputes.id, c.disputeId));
  expect((await c.instance.listQueue()).find((row) => row.caseId === c.caseId)?.nextDeadline).toBe(dispute!.respondBy.toISOString());
  const metadata = resolutions.createResolutionCaseMetadataPort();
  expect(await metadata.readForCase(f.db, detail)).toEqual({ disputeOpenedAt: dispute!.openedAt.toISOString(), respondBy: dispute!.respondBy.toISOString(), ruling: null });
  expect(await accesses(c.caseId)).toHaveLength(0);
  const ruling = await c.rule(); const resolved = await c.instance.getCase(c.caseId);
  const result = await metadata.readForCase(f.db, resolved);
  expect(result.ruling?.id).toBe(ruling.rulingId);
  expect(result.ruling && Object.keys(result.ruling).sort()).toEqual(["correctedAt", "correctionEndsAt", "currentRefundAmountVnd", "id", "outcome", "refundAmountVnd", "ruledAt"]);
  expect((await c.instance.listQueue({ state: "resolved" })).find((row) => row.caseId === c.caseId)?.nextDeadline).toBeNull();
  expect(await accesses(c.caseId)).toHaveLength(0);
}, 30_000);
test("real open and resolved case HTTP details satisfy the browser contract with timeline and access entries", async () => {
  const c = await setup(); const origin = "https://pawket.example.invalid";
  type Input = Parameters<typeof createCaseHttpHandlers>[0];
  const http = createCaseHttpHandlers({ appBaseUrl: origin, authorizeOwner: async () => "authorized", authenticate: async () => c.actor,
    issueOwnerStepUpProof: vi.fn(), cases: c.instance, owner: c.owner, lateClaims: {} as Input["lateClaims"], suspension: {} as Input["suspension"],
    refunds: { readAging: (command) => c.refunds.readAging(f.db, command) }, standing: { readForOrder: async () => "suspended" },
    orderMetadata: { readForOrder: async () => { const facts = await order(c.p);
      return { creatorUserId: facts.creatorUserId, buyerUserId: facts.buyerUserId, orderState: facts.state, amountVnd: facts.amountVnd }; } },
    resolutionMetadata: { readForCase: (row) => resolutions.createResolutionCaseMetadataPort().readForCase(f.db, row) } });
  async function read() {
    const response = await http.detail(new Request(`${origin}/api/v1/admin/cases/${c.caseId}`), c.caseId);
    expect(response.status).toBe(200);
    const parsed = caseDetailSchema.safeParse(await response.json()); expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("Case detail does not satisfy the browser contract");
    return parsed.data.case;
  }
  const opened = await read(); expect(opened.state).toBe("open"); expect(opened.events.map((event) => event.action)).toEqual(["opened"]);
  expect(opened.accessLog).toHaveLength(0); expect(await accesses(c.caseId)).toHaveLength(0);
  await c.read("order_summary"); const viewed = await read(); expect(viewed.accessLog.map((entry) => entry.itemType)).toEqual(["order_summary"]);
  await c.rule(); const resolved = await read(); expect(resolved.state).toBe("resolved"); expect(resolved.orderState).toBe("closed");
  expect(resolved.events.map((event) => event.action)).toEqual(["opened", "resolved"]); expect(resolved.ruling).not.toBeNull();
  expect(await accesses(c.caseId)).toHaveLength(1);
}, 30_000);

test("after the case resolves the same call fails not_available without another log", async () => {
  const c = await setup(); await c.read("order_summary"); await c.rule();
  for (const section of ["order_summary", "thread_page", "resolution_records"] as const) await expect(c.read(section)).rejects.toMatchObject({ code: "not_available" });
  expect(await accesses(c.caseId)).toHaveLength(1);
}, 30_000);
test("refund destination is readable only in a refund case and shows the full account; paid-closed thread remains readable", async () => {
  const c = await setup(); await expect(c.read("refund_destination")).rejects.toMatchObject({ code: "not_available" }); await c.rule();
  const [obligation] = await f.db.select().from(schema.commissionRefundObligations).where(eq(schema.commissionRefundObligations.orderId, c.p.orderId));
  await c.parties.enterDestination({ actor: c.p.buyer, obligationId: obligation!.id, expectedVersion: 1, bankBin: "970422", accountNumber: "000000123456", accountHolder: "SYNTHETIC BUYER", ...commandIds() });
  const opened = await f.db.transaction((tx) => c.cases.openCase(tx, { kind: "refund_overdue", orderId: c.p.orderId, sourceType: "commission_refund_obligation", sourceId: obligation!.id,
    policyRevisionId: c.p.s.policyId, requestId: randomUUID(), at: c.p.s.creator.now() }));
  const destination = await c.read("refund_destination", opened.caseId) as { accountNumber: string }; expect(destination.accountNumber === "000000123456").toBe(true);
  const page = await c.read("thread_page", opened.caseId) as { writable: boolean; items: unknown[] }; expect(page.writable).toBe(false); expect(page.items).toHaveLength(1);
  expect((await accesses(opened.caseId)).map((row) => row.itemType).sort()).toEqual(["refund_destination", "thread_page"]);
}, 30_000);
test("a case file grant for a file of another order fails, and an attached clean file is logged", async () => {
  const c = await setup(); const other = await f.paidOrder(); const submission = await submit(other);
  const attachments = (orderId: string) => f.db.select().from(schema.commissionFileAttachments).where(eq(schema.commissionFileAttachments.orderId, orderId));
  const foreign = (await attachments(other.orderId)).find((row) => row.targetId === submission.id)!;
  const grant = (fileId: string) => c.instance.fileGrant({ ...c.access(), caseId: c.caseId, fileId, disposition: "attachment" });
  await expect(grant(foreign.fileId)).rejects.toMatchObject({ code: "not_available" }); expect(c.storage.presignDownload).not.toHaveBeenCalled(); expect(await accesses(c.caseId)).toHaveLength(0);
  const own = (await attachments(c.p.orderId))[0]!; expect(typeof (await grant(own.fileId)).url).toBe("string"); expect(await accesses(c.caseId)).toMatchObject([{ itemType: "file", itemId: own.fileId }]);
  await c.rule(); await expect(grant(own.fileId)).rejects.toMatchObject({ code: "not_available" }); expect(c.storage.presignDownload).toHaveBeenCalledOnce();
}, 30_000);
test("case event and freeze reasons are owner-only, never in party projections", async () => {
  const c = await setup(); const reason = "Synthetic owner-only case reason";
  await c.owner.extendDispute({ ...c.base(), disputeId: c.disputeId, until: new Date(c.p.s.creator.now().getTime() + 6 * 86_400_000), reason });
  const at = c.p.s.creator.now(); const applicationId = randomUUID(); const revisionId = randomUUID();
  await f.db.insert(schema.creatorApplications).values({ id: applicationId, userId: c.p.creator.userId, state: "approved", version: 2, currentRevisionId: revisionId, createdAt: at, updatedAt: at });
  await f.db.insert(schema.creatorApplicationRevisions).values({ id: revisionId, applicationId, revisionNumber: 1, artistDisplayName: "Synthetic artist", shortIntroduction: "Synthetic introduction", createdAt: at, updatedAt: at });
  await f.db.insert(schema.identityCreatorCapabilities).values({ id: randomUUID(), userId: c.p.creator.userId, state: "suspended", approvedApplicationId: applicationId, approvedRevisionId: revisionId, suspendedAt: at, createdAt: at, updatedAt: at });
  const freezeReason = "Synthetic owner-only freeze reason"; await c.owner.freezeFulfillment({ ...c.base(), creatorUserId: c.p.creator.userId, reason: freezeReason });
  const detail = await c.instance.getCase(c.caseId); expect(detail.events.some((row) => row.reason === reason)).toBe(true); expect(detail.events.some((row) => row.reason === freezeReason)).toBe(true);
  for (const actor of [c.p.buyer, c.p.creator]) {
    const projection = JSON.stringify([await c.view.getOrderResolution({ actor, orderId: c.p.orderId }), await c.view.listMyCases({ actor })]);
    expect(projection.includes(reason)).toBe(false); expect(projection.includes(freezeReason)).toBe(false);
  }
}, 30_000);
test("real runtime refuses a non-owner session with a forged proof and rejects owner command replay authorization", async () => {
  const c = await setup(); const actor = c.p.buyer; const at = new Date(); const origin = "https://pawket.example.invalid"; const token = randomBytes(32).toString("base64url");
  await f.db.update(schema.identityUsers).set({ emailVerified: true, emailVerifiedAt: at, emailVerificationProvenance: "password_email_challenge" }).where(eq(schema.identityUsers.id, actor.userId));
  await f.db.insert(schema.identitySessions).values({ id: actor.sessionId, userId: actor.userId, token: hashSessionToken(token), createdAt: at, updatedAt: at, lastUsedAt: at,
    primaryAuthenticatedAt: at, assuranceState: "active", authorizationVersion: 1, expiresAt: new Date(at.getTime() + 86_400_000), idleExpiresAt: new Date(at.getTime() + 86_400_000), absoluteExpiresAt: new Date(at.getTime() + 86_400_000) });
  await attachSyntheticOidcSession(f.db, { ...actor, now: at });
  const env = config.parseServerEnv({ NODE_ENV: "test", APP_ENV: "test", APP_REVISION: "synthetic-i8", DATABASE_URL: process.env.TEST_DATABASE_URL,
    VALKEY_URL: process.env.TEST_VALKEY_URL, METRICS_TOKEN: "synthetic-metrics-token-0000000000", APP_BASE_URL: origin, AUTH_TRUSTED_ORIGINS: origin });
  vi.spyOn(config, "loadServerEnv").mockReturnValue({ ...env, PII_ACTIVE_KEY_ID: "sepay-services-test", PII_KEYRING_JSON: { "sepay-services-test": Buffer.from(fixtureKey).toString("base64") },
    PII_LOOKUP_HMAC_KEY: Buffer.from(fixtureKey).toString("base64"), VN_BUSINESS_CALENDAR_VERSION: "vn-proposals-test", COMMISSION_FULFILLMENT_MODE: "enabled", COMMISSION_RESOLUTION_MODE: "enabled" });
  vi.spyOn(config, "parseOidcEnv").mockReturnValue({ ...syntheticOidcProvider, clientSecret: "synthetic-client-secret-0000000000", redirectUri: `${origin}/api/v1/auth/oidc/callback`, accountPortalUrl: "https://idp.example.invalid/if/user/" });
  vi.spyOn(database, "createDatabase").mockReturnValue({ db: f.db, close: async () => undefined });
  const kits = vi.spyOn(resolutions, "createResolutionCommandKit"); const owners = vi.spyOn(resolutions, "createOwnerResolutionService");
  try {
    const runtime = getPlatformRuntime(); const rule = vi.spyOn(owners.mock.results[0]!.value, "rule");
    const headers = { origin, "content-type": "application/json", "idempotency-key": randomUUID(), cookie: `${resolveSessionCookie(origin).name}=${token}` };
    const response = await runtime.caseHandlers.action(new Request(`${origin}/api/v1/admin/cases/${c.caseId}/actions`, { method: "POST", headers,
      body: JSON.stringify({ action: "rule", outcome: "close", refundAmountVnd: 0, reasoning: "Synthetic reason", stepUpProofId: randomUUID() }) }), c.caseId);
    expect(response.status).toBe(403); expect(rule).not.toHaveBeenCalled(); expect((await order(c.p)).state).toBe("delivered"); expect(await accesses(c.caseId)).toHaveLength(0);
    const ownerKit = kits.mock.calls.find(([input]) => input.consumeStepUpProof !== undefined)![0];
    await expect(f.db.transaction((tx) => ownerKit.authorizeCommand!(tx, actor))).rejects.toMatchObject({ code: "not_authorized" });
  } finally { vi.restoreAllMocks(); }
}, 30_000);
