import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import * as config from "@pawket/config";
import * as database from "@pawket/database";
import { hashSessionToken, resolveSessionCookie } from "@pawket/identity";
import { fixtureKey, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";
import { createCommissionResolutionTestFixture, cleanFile } from "./commission-resolution-test-support.js";
import { attachSyntheticOidcSession, syntheticOidcProvider } from "./oidc-test-support.js";
import { getPlatformRuntime } from "../src/platform/runtime.js";

const f = createCommissionResolutionTestFixture("resolution_runtime");
beforeAll(f.initialize, 30_000); afterAll(f.dispose, 30_000);
test("real runtime HTTP holds completion on disputes and pauses catalog intake on overdue refunds", async () => {
  const p = await f.paidOrder(); const at = new Date(); p.s.creator.setNow(at);
  const origin = "https://pawket.example.invalid"; const tokens = new Map<string, string>();
  async function refreshSessions(now: Date, initial = false) {
    for (const [userId, sessionId] of p.s.users) {
      if (initial) {
        const token = randomBytes(32).toString("base64url"); tokens.set(userId, token);
        await f.db.update(schema.identityUsers).set({ emailVerified: true, emailVerifiedAt: now, emailVerificationProvenance: "password_email_challenge" }).where(eq(schema.identityUsers.id, userId));
        await f.db.insert(schema.identitySessions).values({ id: sessionId, userId, token: hashSessionToken(token), createdAt: now, updatedAt: now,
          lastUsedAt: now, primaryAuthenticatedAt: now, assuranceState: "active", authorizationVersion: 1,
          expiresAt: new Date(now.getTime() + 86_400_000), idleExpiresAt: new Date(now.getTime() + 86_400_000), absoluteExpiresAt: new Date(now.getTime() + 86_400_000) });
      } else await f.db.update(schema.identitySessions).set({ primaryAuthenticatedAt: now, lastUsedAt: now, updatedAt: now,
        expiresAt: new Date(now.getTime() + 86_400_000), idleExpiresAt: new Date(now.getTime() + 86_400_000), absoluteExpiresAt: new Date(now.getTime() + 86_400_000) }).where(eq(schema.identitySessions.id, sessionId));
      await attachSyntheticOidcSession(f.db, { userId, sessionId, now });
    }
  }
  await refreshSessions(at, true);
  const applicationId = randomUUID(); const revisionId = randomUUID();
  await f.db.insert(schema.creatorApplications).values({ id: applicationId, userId: p.creator.userId, state: "approved", version: 3, currentRevisionId: revisionId, createdAt: at, updatedAt: at });
  await f.db.insert(schema.creatorApplicationRevisions).values({ id: revisionId, applicationId, revisionNumber: 1, artistDisplayName: "Synthetic artist", shortIntroduction: "Synthetic approved creator", createdAt: at, updatedAt: at });
  await f.db.insert(schema.identityCreatorCapabilities).values({ id: randomUUID(), userId: p.creator.userId, state: "active", version: 1, approvedApplicationId: applicationId, approvedRevisionId: revisionId, createdAt: at, updatedAt: at });
  const env = config.parseServerEnv({ NODE_ENV: "test", APP_ENV: "test", APP_REVISION: "synthetic-i8", DATABASE_URL: process.env.TEST_DATABASE_URL,
    VALKEY_URL: process.env.TEST_VALKEY_URL, METRICS_TOKEN: "synthetic-metrics-token-0000000000", APP_BASE_URL: origin, AUTH_TRUSTED_ORIGINS: origin });
  vi.spyOn(config, "loadServerEnv").mockReturnValue({ ...env, PII_ACTIVE_KEY_ID: "sepay-services-test", PII_KEYRING_JSON: { "sepay-services-test": Buffer.from(fixtureKey).toString("base64") },
    PII_LOOKUP_HMAC_KEY: Buffer.from(fixtureKey).toString("base64"), CREATOR_PUBLISHING_MODE: "general_audience", VN_BUSINESS_CALENDAR_VERSION: "vn-proposals-test",
    COMMISSION_INTAKE_MODE: "enabled", COMMISSION_PAYMENTS_MODE: "manual_only", COMMISSION_FULFILLMENT_MODE: "enabled", COMMISSION_RESOLUTION_MODE: "enabled", COMMISSION_FILES_MODE: "enabled" });
  vi.spyOn(config, "parseOidcEnv").mockReturnValue({ ...syntheticOidcProvider, clientSecret: "synthetic-client-secret-0000000000", redirectUri: `${origin}/api/v1/auth/oidc/callback`, accountPortalUrl: "https://idp.example.invalid/if/user/" });
  vi.spyOn(database, "createDatabase").mockReturnValue({ db: f.db, close: async () => undefined });
  try {
    const runtime = getPlatformRuntime(); const http = runtime.resolutionHandlers;
    const req = (suffix: string, body: unknown, actor = p.buyer) => new Request(`${origin}/api/v1/${actor === p.creator ? "creator/" : ""}commissions/${p.orderId}/${suffix}`, {
      method: "POST", body: JSON.stringify(body), headers: { origin, "content-type": "application/json", "x-real-ip": "192.0.2.66", "idempotency-key": randomUUID(), cookie: `${resolveSessionCookie(origin).name}=${tokens.get(actor.userId)}` } });
    const order = () => runtime.commissions.getOrder({ actor: p.buyer, orderId: p.orderId });
    const final = await runtime.commissionHandlers.submit(req("submissions", { expectedVersion: (await order()).version, kind: "final", fileIds: [await cleanFile(p)] }, p.creator), p.orderId);
    expect(final.status).toBe(200);
    const [submission] = await f.db.select().from(schema.commissionSubmissions).where(eq(schema.commissionSubmissions.orderId, p.orderId));
    const opened = await http.openDispute(req("disputes", { expectedVersion: (await order()).version, reason: "not_as_agreed", statement: "Synthetic statement",
      requestedOutcome: { kind: "close", refundAmountVnd: 500_000 }, acknowledgeStaffReview: true }), p.orderId, "buyer");
    expect(opened.status).toBe(200); const { disputeId } = await opened.json() as { disputeId: string };
    const held = await runtime.commissionHandlers.respond(req(`submissions/${submission!.id}/respond`, { expectedVersion: (await order()).version, response: "accept" }), p.orderId, submission!.id);
    expect(held.status).toBe(409); expect(await held.json()).toEqual({ code: "completion_held" }); expect((await order()).state).toBe("delivered");
    expect((await http.withdrawDispute(req(`disputes/${disputeId}/withdraw`, {}), p.orderId, disputeId, "buyer")).status).toBe(200);
    const proposed = await http.propose(req("proposals", { expectedVersion: (await order()).version, kind: "cancel_with_refund", refundAmountVnd: 500_000, note: "Synthetic note" }), p.orderId, "buyer");
    expect(proposed.status).toBe(200); const { proposalId } = await proposed.json() as { proposalId: string };
    expect((await http.respondProposal(req(`proposals/${proposalId}/respond`, { response: "accept" }, p.creator), p.orderId, proposalId, "creator")).status).toBe(200);
    const [obligation] = await f.db.select().from(schema.commissionRefundObligations).where(eq(schema.commissionRefundObligations.orderId, p.orderId));
    expect((await http.enterRefundDestination(req(`refunds/${obligation!.id}/destination`, { expectedVersion: 1, bankBin: "970415", accountNumber: "123456789", accountHolder: "Synthetic Buyer" }), p.orderId, obligation!.id)).status).toBe(200);
    const [entered] = await f.db.select().from(schema.commissionRefundObligations).where(eq(schema.commissionRefundObligations.id, obligation!.id));
    const afterDeadline = new Date(entered!.dueAt!.getTime() + 1); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(afterDeadline);
    await refreshSessions(afterDeadline);
    const workspace = await runtime.commissionCatalog.getWorkspace(p.creator);
    expect(workspace.intakePause.paused).toBe(true); expect(workspace.intakePause.overdue.map((row) => row.obligationId)).toEqual([obligation!.id]);
    expect((await http.recordRefundSend(req(`refunds/${obligation!.id}/send`, { expectedVersion: 2, transferDate: database.vietnamDateFromInstant(afterDeadline), bankReference: "synthetic-reference" }, p.creator), p.orderId, obligation!.id)).status).toBe(200);
    expect((await runtime.commissionCatalog.getWorkspace(p.creator)).intakePause.paused).toBe(false);
  } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
}, 30_000);
