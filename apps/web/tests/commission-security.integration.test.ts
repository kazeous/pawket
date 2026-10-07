import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import * as config from "@pawket/config";
import * as database from "@pawket/database";
import { createIdentityCommissionAssurancePort, hashSessionToken, resolveSessionCookie } from "@pawket/identity";
import { encryptCommissionFileName } from "@pawket/commission-files";
import { createCommissionOrderService } from "@pawket/orders";
import { createCreatorCommissionPaymentService } from "@pawket/payments";
import { createCommissionTrustPort } from "@pawket/trust";
import { commandIds, deferred, fixtureHash, fixtureKey, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";
import { createCommissionOrderTestFixture } from "./commission-order-test-support.js";
import { attachSyntheticOidcSession, syntheticOidcProvider } from "./oidc-test-support.js";
import { getPlatformRuntime } from "../src/platform/runtime.js";
import { oidcCommand } from "../src/platform/oidc-command-registry.js";

const f = createCommissionOrderTestFixture("commission_security");
beforeAll(f.initialize, 30_000); afterAll(f.dispose, 30_000);

async function setup() {
  const s = await f.setup(); const at = s.creator.now();
  for (const [userId, sessionId] of s.users) {
    await f.db.update(schema.identityUsers).set({ emailVerified: true, emailVerifiedAt: at,
      emailVerificationProvenance: "password_email_challenge" }).where(eq(schema.identityUsers.id, userId));
    await f.db.insert(schema.identitySessions).values({ id: sessionId, userId, token: fixtureHash(), createdAt: at, updatedAt: at,
      lastUsedAt: at, primaryAuthenticatedAt: at, assuranceState: "active", authorizationVersion: 1,
      expiresAt: new Date(at.getTime() + 86_400_000), idleExpiresAt: new Date(at.getTime() + 86_400_000), absoluteExpiresAt: new Date(at.getTime() + 86_400_000) });
    await attachSyntheticOidcSession(f.db, { userId, sessionId, now: at });
  }
  const applicationId = randomUUID(); const revisionId = randomUUID();
  await f.db.insert(schema.creatorApplications).values({ id: applicationId, userId: s.creator.actor.userId, state: "approved", version: 3,
    currentRevisionId: revisionId, createdAt: at, updatedAt: at });
  await f.db.insert(schema.creatorApplicationRevisions).values({ id: revisionId, applicationId, revisionNumber: 1,
    artistDisplayName: "Synthetic artist", shortIntroduction: "Synthetic approved creator", createdAt: at, updatedAt: at });
  await f.db.insert(schema.identityCreatorCapabilities).values({ id: randomUUID(), userId: s.creator.actor.userId, state: "active", version: 1,
    approvedApplicationId: applicationId, approvedRevisionId: revisionId, createdAt: at, updatedAt: at });
  const identity = createIdentityCommissionAssurancePort(syntheticOidcProvider, s.creator.now);
  const input = { ...s.input, identity, trust: createCommissionTrustPort() };
  const service = createCommissionOrderService(input);
  const manual = createCreatorCommissionPaymentService({ ...s.creator.common, applicationRevision: "synthetic-i6", paymentsMode: "manual_only",
    recentAuthMs: 900_000, mfaAuthMs: 300_000, assurance: identity, commissions: service.paymentsLifecycle });
  const detail = (orderId: string) => service.getOrder({ actor: s.buyerActor, orderId });
  async function pending() {
    const orderId = await service.request(s.request()); const payment = (await detail(orderId)).payment!;
    const command = { actor: s.creator.actor, paymentIntentId: payment.id, observedAmountVnd: payment.amountVnd,
      observedTransferReference: payment.reference, observedBankTransactionId: randomUUID(), attestedReceived: true, ...commandIds() };
    return { orderId, command };
  }
  return { ...s, service, input, detail, pending, manual };
}
type Setup = Awaited<ReturnType<typeof setup>>;
async function state(orderId: string) {
  const [order] = await f.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, orderId));
  const [slot] = await f.db.select().from(schema.commissionReservations).where(eq(schema.commissionReservations.orderId, orderId));
  const [payment] = await f.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.commissionOrderId, orderId));
  return { order, slot, payment };
}
async function hold(s: Setup) {
  await f.db.transaction(async (tx) => {
    const [page] = await tx.select().from(schema.creatorPages).where(eq(schema.creatorPages.id, s.pageId)).for("update");
    const reportId = randomUUID(); const holdId = randomUUID(); const at = s.creator.now(); const requestId = randomUUID();
    await tx.insert(schema.publicContentReports).values({ id: reportId, reportReference: `report:v1:${randomUUID()}`, targetType: "page",
      targetId: s.pageId, publicationRevisionId: page!.publishedRevisionId!, reason: "spam_or_scam", createdAt: at, updatedAt: at });
    await tx.update(schema.publicContentReports).set({ state: "held", version: 2 }).where(eq(schema.publicContentReports.id, reportId));
    await tx.insert(schema.publicVisibilityHolds).values({ id: holdId, reportId, targetType: "page", targetId: s.pageId,
      publicationRevisionId: page!.publishedRevisionId!, reason: "Synthetic moderation hold", actorUserId: s.creator.actor.userId,
      actorSessionId: s.creator.actor.sessionId, requestId, createdAt: at });
    await tx.insert(schema.publicContentTriageEvents).values({ id: randomUUID(), reportId, holdId, action: "hide", actorUserId: s.creator.actor.userId,
      actorSessionId: s.creator.actor.sessionId, reason: "Synthetic moderation hold", requestId, expectedReportVersion: 1,
      resultingReportVersion: 2, beforeState: "open", afterState: "held", occurredAt: at });
  });
}

describe("commission effective security invalidation", () => {
  test("fulfillment command registry fixes route roles and keeps messages and grants unregistered", () => {
    const orderId = randomUUID(); const submissionId = randomUUID();
    const command = (path: string) => oidcCommand({ method: "POST", path, body: "{}", idempotencyKey: randomUUID(), ifMatch: null, returnPath: "/" });
    for (const [path, actionClass, returnPath] of [
      [`/api/v1/creator/commissions/${orderId}/submissions`, "orders.commission_submit", `/creator/commissions/${orderId}`],
      [`/api/v1/commissions/${orderId}/submissions/${submissionId}/respond`, "orders.commission_respond", `/commissions/${orderId}`],
    ]) expect(command(path!)).toMatchObject({ policy: { actionClass, fresh: false }, returnPath, title: "Cập nhật commission" });
    for (const path of [`/api/v1/commissions/${orderId}/submissions`, `/api/v1/creator/commissions/${orderId}/submissions/${submissionId}/respond`,
      `/api/v1/commissions/${orderId}/messages`, `/api/v1/creator/commissions/${orderId}/messages`, "/api/v1/commission-files",
      `/api/v1/commissions/${orderId}/files/${randomUUID()}`, `/api/v1/creator/commissions/${orderId}/files/${randomUUID()}`]) expect(command(path)).toBeNull();
  });
  test("real runtime authorizes submit and respond and limits messages per actor and order", async () => {
    const s = await setup(); const p = await s.pending(); await s.manual.confirm(p.command);
    const at = new Date(); s.creator.setNow(at);
    const tokens = new Map<string, string>();
    for (const [userId, sessionId] of s.users) {
      const token = randomBytes(32).toString("base64url"); tokens.set(userId, token);
      await f.db.update(schema.identitySessions).set({ token: hashSessionToken(token), primaryAuthenticatedAt: at,
        expiresAt: new Date(at.getTime() + 86_400_000), idleExpiresAt: new Date(at.getTime() + 86_400_000), absoluteExpiresAt: new Date(at.getTime() + 86_400_000) }).where(eq(schema.identitySessions.id, sessionId));
      await attachSyntheticOidcSession(f.db, { userId, sessionId, now: at });
    }
    const second = await s.pending(); await s.manual.confirm(second.command);
    const origin = "https://pawket.example.invalid";
    const env = config.parseServerEnv({ NODE_ENV: "test", APP_ENV: "test", APP_REVISION: "synthetic-i7", DATABASE_URL: process.env.TEST_DATABASE_URL,
      VALKEY_URL: process.env.TEST_VALKEY_URL, METRICS_TOKEN: "synthetic-metrics-token-0000000000", APP_BASE_URL: origin, AUTH_TRUSTED_ORIGINS: origin });
    const envSpy = vi.spyOn(config, "loadServerEnv").mockReturnValue({ ...env, PII_ACTIVE_KEY_ID: "sepay-services-test",
      PII_KEYRING_JSON: { "sepay-services-test": Buffer.from(fixtureKey).toString("base64") }, PII_LOOKUP_HMAC_KEY: Buffer.from(fixtureKey).toString("base64"),
      COMMISSION_INTAKE_MODE: "enabled", COMMISSION_PAYMENTS_MODE: "manual_only", COMMISSION_FULFILLMENT_MODE: "enabled", COMMISSION_RESOLUTION_MODE: "enabled", COMMISSION_FILES_MODE: "enabled", COMMISSION_MESSAGE_LIMIT: 2 });
    const oidcSpy = vi.spyOn(config, "parseOidcEnv").mockReturnValue({ ...syntheticOidcProvider, clientSecret: "synthetic-client-secret-0000000000",
      redirectUri: `${origin}/api/v1/auth/oidc/callback`, accountPortalUrl: "https://idp.example.invalid/if/user/" });
    const dbSpy = vi.spyOn(database, "createDatabase").mockReturnValue({ db: f.db, close: async () => undefined });
    try {
      const runtime = getPlatformRuntime(); const http = runtime.commissionHandlers;
      expect(typeof http.submit).toBe("function"); expect(typeof http.respond).toBe("function");
      const req = (path: string, body: unknown, actor = s.buyerActor) => new Request(`${origin}${path}`, { method: "POST", body: JSON.stringify(body),
        headers: { origin, "content-type": "application/json", "x-real-ip": "192.0.2.62", "idempotency-key": randomUUID(),
          cookie: `${resolveSessionCookie(origin).name}=${tokens.get(actor.userId)}` } });
      const fileId = randomUUID();
      await f.db.insert(schema.commissionFiles).values({ id: fileId, context: "submission", uploadOrderId: p.orderId, ownerUserId: s.creator.actor.userId,
        declaredBytes: 16, filenameEnvelope: encryptCommissionFileName(s.input.keyring, fileId, "Synthetic artwork"), objectKey: `commission/${fileId}`,
        uploadExpiresAt: new Date(at.getTime() + 900_000), requestId: "fixture", createdAt: at, updatedAt: at });
      await f.db.update(schema.commissionFiles).set({ state: "scanning", uploadedAt: at, scanDeadlineAt: new Date(at.getTime() + 86_400_000), version: 2 }).where(eq(schema.commissionFiles.id, fileId));
      await f.db.update(schema.commissionFiles).set({ state: "clean", sha256: `sha256:${"d".repeat(64)}`, detectedType: "png", quarantineVersionId: "q", cleanVersionId: "c", cleanAt: at, version: 3 }).where(eq(schema.commissionFiles.id, fileId));
      const submissionPath = `/api/v1/creator/commissions/${p.orderId}/submissions`;
      const submit = req(submissionPath, { expectedVersion: 2, kind: "draft", fileIds: [fileId] }, s.creator.actor);
      const submitted = await http.submit(submit.clone(), p.orderId); expect(submitted.status).toBe(200);
      expect(await submitted.json()).toEqual({ orderId: p.orderId }); expect((await http.submit(submit.clone(), p.orderId)).status).toBe(200);
      const [submission] = await f.db.select().from(schema.commissionSubmissions).where(eq(schema.commissionSubmissions.orderId, p.orderId));
      const responsePath = `/api/v1/commissions/${p.orderId}/submissions/${submission!.id}/respond`;
      const respond = req(responsePath, { expectedVersion: 2, response: "approve" });
      const responded = await http.respond(respond.clone(), p.orderId, submission!.id); expect(responded.status).toBe(200);
      expect(await responded.json()).toEqual({ orderId: p.orderId }); expect((await http.respond(respond.clone(), p.orderId, submission!.id)).status).toBe(200);
      const send = (orderId: string, actor = s.buyerActor) => http.message(req(`/api/v1/${actor === s.creator.actor ? "creator/" : ""}commissions/${orderId}/messages`, { text: "Synthetic private text" }, actor), orderId, actor === s.creator.actor ? "creator" : "buyer");
      expect((await send(p.orderId)).status).toBe(200); expect((await send(p.orderId)).status).toBe(200);
      const limited = await send(p.orderId); expect(limited.status).toBe(429); expect(await limited.json()).toEqual({ code: "rate_limited" });
      expect((await send(second.orderId)).status).toBe(200); expect((await send(p.orderId, s.creator.actor)).status).toBe(200);
      const throttles = await f.db.select().from(schema.identitySecurityThrottles).where(eq(schema.identitySecurityThrottles.action, "commission_message"));
      expect(throttles.length).toBe(6); expect(throttles.every((row) => !row.subjectHmac.includes(s.buyerActor.userId) && !row.subjectHmac.includes(p.orderId))).toBe(true);
      await f.db.update(schema.identitySessions).set({ revokedAt: new Date(), revocationReason: "synthetic-test" }).where(eq(schema.identitySessions.id, s.buyerActor.sessionId));
      expect((await http.respond(req(responsePath, { expectedVersion: 2, response: "approve" }), p.orderId, submission!.id)).status).toBe(401);
      await f.db.update(schema.identityUsers).set({ accessStatus: "access_suspended" }).where(eq(schema.identityUsers.id, s.creator.actor.userId));
      expect((await send(second.orderId, s.creator.actor)).status).toBe(401);
    } finally { envSpy.mockRestore(); oidcSpy.mockRestore(); dbSpy.mockRestore(); }
  }, 30_000);
  test.each(["authorization_version", "revoked_session", "unverified_email"] as const)("real %s invalidation cannot read or act", async (kind) => {
    const s = await setup(); const p = await s.pending();
    if (kind === "authorization_version") await f.db.update(schema.identityUsers).set({ authorizationVersion: 2 }).where(eq(schema.identityUsers.id, s.buyerActor.userId));
    if (kind === "revoked_session") await f.db.update(schema.identitySessions).set({ revokedAt: s.creator.now(), revocationReason: "synthetic-test" }).where(eq(schema.identitySessions.id, s.buyerActor.sessionId));
    if (kind === "unverified_email") await f.db.update(schema.identityUsers).set({ emailVerified: false, emailVerifiedAt: null, emailVerificationProvenance: null }).where(eq(schema.identityUsers.id, s.buyerActor.userId));
    await expect(s.detail(p.orderId)).rejects.toMatchObject({ code: "not_authorized" });
    await expect(s.service.request(s.request())).rejects.toMatchObject({ code: "not_authorized" });
    // A revoked buyer session does not revoke the buyer account or an already accepted payment.
    if (kind === "unverified_email") await expect(s.manual.confirm(p.command)).rejects.toMatchObject({ code: "not_available" });
  });
  test("creator suspension blocks pending QR and confirmation before cleanup, preserving paid obligations", async () => {
    const s = await setup(); const paid = await s.pending(); await s.manual.confirm(paid.command); const pending = await s.pending();
    await f.db.update(schema.identityCreatorCapabilities).set({ state: "suspended", version: 2, suspendedAt: s.creator.now() })
      .where(eq(schema.identityCreatorCapabilities.userId, s.creator.actor.userId));
    expect((await s.detail(pending.orderId)).payment?.instruction).toBeNull();
    await expect(s.manual.confirm(pending.command)).rejects.toMatchObject({ code: "not_available" });
    expect((await state(pending.orderId)).slot?.state).toBe("reserved");
    const paused = createCommissionOrderService({ ...s.input, intakeMode: "disabled", paymentsMode: "disabled" });
    await paused.recoverInvalidations();
    expect(await state(pending.orderId)).toMatchObject({ order: { state: "closed", closeReason: "security_invalidated" }, slot: { state: "released" }, payment: { state: "rejected" } });
    expect(await state(paid.orderId)).toMatchObject({ order: { state: "in_progress" }, slot: { state: "occupied" }, payment: { state: "confirmed" } });
    expect((await paused.recoverInvalidations()).invalidated).toBe(0);
  });
  test("retiring the destination hides QR and rejects confirmation, then atomically releases the reservation", async () => {
    const s = await setup(); const p = await s.pending();
    await f.db.update(schema.paymentsReceivingAccountOnboarding).set({ retiredAt: s.creator.now(), updatedAt: s.creator.now() })
      .where(eq(schema.paymentsReceivingAccountOnboarding.id, s.creator.accountVersionId));
    expect((await s.detail(p.orderId)).payment?.instruction).toBeNull();
    await expect(s.manual.confirm(p.command)).rejects.toMatchObject({ code: "evidence_mismatch" });
    await s.service.recoverInvalidations();
    expect(await state(p.orderId)).toMatchObject({ order: { state: "closed", closeReason: "eligibility_invalidated" }, slot: { state: "released" }, payment: { state: "rejected" } });
  });
  test("a moderation hold invalidates existing payment but ordinary unpublishing preserves settlement", async () => {
    const s = await setup(); const p = await s.pending(); await hold(s);
    expect((await s.detail(p.orderId)).payment?.instruction).toBeNull();
    await expect(s.manual.confirm(p.command)).rejects.toMatchObject({ code: "not_available" });
    await s.service.recoverInvalidations(); expect((await state(p.orderId)).order?.closeReason).toBe("security_invalidated");
    const other = await setup(); const valid = await other.pending();
    await f.db.update(schema.creatorPages).set({ publishedRevisionId: null }).where(eq(schema.creatorPages.id, other.pageId));
    expect((await other.detail(valid.orderId)).payment?.instruction).toBeTruthy();
    await other.service.recoverInvalidations(); await other.manual.confirm(valid.command);
    expect((await state(valid.orderId)).order?.state).toBe("in_progress");
  });
  test.each(["capability", "page"] as const)("a busy %s fence fails safely without false invalidation or a lock cycle", async (kind) => {
    const s = await setup(); const p = await s.pending(); const locked = deferred<void>(); const release = deferred<void>();
    const writer = f.db.transaction(async (tx) => {
      if (kind === "capability") await tx.select().from(schema.identityCreatorCapabilities).where(eq(schema.identityCreatorCapabilities.userId, s.creator.actor.userId)).for("update");
      else await tx.select().from(schema.creatorPages).where(eq(schema.creatorPages.id, s.pageId)).for("update");
      locked.resolve(); await release.promise;
      // Existing Identity/Trust writers acquire the user after capability/page.
      await tx.select().from(schema.identityUsers).where(eq(schema.identityUsers.id, s.buyerActor.userId)).for("update");
    });
    await locked.promise;
    try {
      await expect(s.detail(p.orderId)).rejects.toMatchObject({ code: "dependency_unavailable" });
      await expect(s.manual.confirm(p.command)).rejects.toMatchObject({ code: "dependency_unavailable" });
      expect((await s.service.recoverInvalidations()).deferred).toBeGreaterThanOrEqual(1);
      expect(await state(p.orderId)).toMatchObject({ order: { state: "awaiting_payment" }, slot: { state: "reserved" }, payment: { state: "awaiting_transfer" } });
    } finally { release.resolve(); await writer; }
    await s.manual.confirm(p.command); expect((await state(p.orderId)).order?.state).toBe("in_progress");
  });
});
